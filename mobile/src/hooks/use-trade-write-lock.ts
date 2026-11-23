import { useCallback, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { TradeWriteUncertainError, TradeWriteValidationError } from '../lib/trade-write';

const key = 'guardian.trade-write';
type State = 'checking' | 'ready' | 'pending' | 'uncertain';

export function useTradeWriteLock() {
  const current = useRef<State>('checking');
  const [state, setState] = useState<State>('checking');

  const update = useCallback((next: State) => {
    current.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    void SecureStore.getItemAsync(key).then(
      value => update(value === null ? 'ready' : 'uncertain'),
      () => update('uncertain'),
    );
  }, [update]);

  const clear = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync(key);
      update('ready');
    } catch {
      update('uncertain');
    }
  }, [update]);

  const acknowledge = useCallback(async () => {
    if (current.current !== 'uncertain') return;
    update('checking');
    await clear();
  }, [clear, update]);

  const run = useCallback(async <T,>(send: () => Promise<T>, requestId?: string): Promise<T> => {
    if (current.current === 'uncertain') throw new TradeWriteUncertainError();
    if (current.current !== 'ready') throw new Error('An account request is already being checked.');
    update('pending');
    // Save before sending so an app restart cannot turn an unresolved write into a retry.
    try {
      await SecureStore.setItemAsync(key, requestId ?? 'pending');
    } catch {
      update('uncertain');
      throw new TradeWriteUncertainError();
    }
    try {
      const result = await send();
      await clear();
      return result;
    } catch (error) {
      if (error instanceof TradeWriteValidationError) {
        await clear();
        throw error;
      }
      update('uncertain');
      throw new TradeWriteUncertainError();
    }
  }, [clear, update]);

  return { state, run, acknowledge };
}
