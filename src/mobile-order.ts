import { MfpClient, MfpError } from './mfp.js';
import { MobileWriteUncertainError } from './mobile-errors.js';

export const entryClientOrderId = (id: string) => `guardian-native-${id}`;
export const mobileOrderHosts = {live:'https://developers.myfundedperpetuals.com',sandbox:'https://sandbox.myfundedperpetuals.com'};

export function orderReceipt(order: Record<string, unknown> | undefined) {
  const orderId = order?.id ?? order?.order_id;
  const status = order?.status;
  if (typeof orderId === 'string' && orderId.trim() && typeof status === 'string' && status.trim()) {
    return {dryRun:false,status,orderId};
  }
}

export function orderRequestRejected(error: unknown) {
  // orderWrite preserves an earlier ambiguous failure over a later rate limit.
  return error instanceof MfpError && [400,401,403,404,422,429].includes(error.status);
}

export async function reconcileOrder(client: MfpClient, clientOrderId: string, accountId: string, submittedAt?: Date) {
  const lookupStartedAt = Date.now();
  const lookup = await client.findOrderByClientOrderId(clientOrderId,accountId);
  if (lookup.status === 'found') return orderReceipt(lookup.order);
  if (lookup.status === 'absent' && submittedAt && lookupStartedAt - submittedAt.getTime() >= 60_000) {
    return {status:'not_submitted'} as const;
  }
}

export async function submitOrder(client: MfpClient, clientOrderId: string, accountId: string, send: () => Promise<Record<string, unknown>>) {
  try {
    const result = orderReceipt(await send());
    if (result) return result;
    throw new MobileWriteUncertainError('The order could not be confirmed.');
  } catch (error) {
    if (orderRequestRejected(error)) throw error;
    const result = await reconcileOrder(client,clientOrderId,accountId);
    if (result) return result;
    throw error;
  }
}
