import { useCallback, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { parseConfirmRetry, TradeWriteUncertainError, TradeWriteValidationError, type ConfirmRetry } from '../lib/trade-write';

const key = 'guardian.trade-write';
type State = 'checking' | 'ready' | 'pending' | 'uncertain';

export function useTradeWriteLock() {
  const current = useRef<State>('checking');
  const savedConfirm = useRef<ConfirmRetry | undefined>(undefined);
  const [state, setState] = useState<State>('checking');
  const [confirm, setConfirm] = useState<ConfirmRetry>();

  const saveConfirm = useCallback((value: ConfirmRetry | undefined) => {
    savedConfirm.current = value;
    setConfirm(value);
  }, []);

  const update = useCallback((next: State) => {
    current.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    void SecureStore.getItemAsync(key).then(
      value => {
        saveConfirm(parseConfirmRetry(value));
        update(value === null ? 'ready' : 'uncertain');
      },
      () => update('uncertain'),
    );
  }, [saveConfirm, update]);

  const clear = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync(key);
      saveConfirm(undefined);
      update('ready');
    } catch {
      update('uncertain');
    }
  }, [saveConfirm, update]);

  const acknowledge = useCallback(async () => {
    if (current.current !== 'uncertain' || savedConfirm.current) return;
    update('checking');
    await clear();
  }, [clear, update]);

  const complete = useCallback(async <T,>(send: () => Promise<T>): Promise<T> => {
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

  const run = useCallback(async <T,>(send: () => Promise<T>, intent?: string | ConfirmRetry): Promise<T> => {
    if (current.current === 'uncertain') throw new TradeWriteUncertainError();
    if (current.current !== 'ready') throw new Error('An account request is already being checked.');
    update('pending');
    // Save the original ticket before sending so it can be checked after an app restart.
    const recovery = typeof intent === 'object' ? intent : undefined;
    try {
      await SecureStore.setItemAsync(key, typeof intent === 'object' ? JSON.stringify(intent) : intent ?? 'pending');
      saveConfirm(recovery);
    } catch {
      update('uncertain');
      throw new TradeWriteUncertainError();
    }
    return complete(send);
  }, [complete, saveConfirm, update]);

  const check = useCallback(async <T,>(userId: string, send: (intent: ConfirmRetry) => Promise<T>) => {
    const intent = savedConfirm.current;
    if (current.current !== 'uncertain' || intent?.userId !== userId) throw new TradeWriteUncertainError();
    update('pending');
    return complete(() => send(intent));
  }, [complete, update]);

  return { state, run, acknowledge, confirm, check };
}
