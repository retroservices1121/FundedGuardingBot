import { MfpClient, MfpError } from './mfp.js';
import { MobileWriteUncertainError } from './mobile-errors.js';

export function orderReceipt(order: Record<string, unknown> | undefined) {
  const orderId = order?.id ?? order?.order_id;
  const status = order?.status;
  if (typeof orderId === 'string' && orderId.trim() && typeof status === 'string' && status.trim()) {
    return {dryRun:false,status,orderId};
  }
}

export function orderRequestRejected(error: unknown) {
  return error instanceof MfpError && [400,401,403,404,422].includes(error.status);
}

export async function reconcileOrder(client: MfpClient, clientOrderId: string, accountId: string) {
  // An empty or failed lookup leaves the outcome uncertain.
  const order = await client.findOrderByClientOrderId(clientOrderId,accountId).catch(() => undefined);
  return orderReceipt(order);
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
