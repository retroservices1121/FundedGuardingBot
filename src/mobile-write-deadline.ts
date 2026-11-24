import { AsyncLocalStorage } from "node:async_hooks";
import { MobileWriteUncertainError } from "./mobile-errors.js";

const writeDeadline = new AsyncLocalStorage<AbortSignal>();

export function mobileWriteSignal() {
  return writeDeadline.getStore();
}

export async function withinMobileWriteDeadline<T>(run: () => Promise<T>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new MobileWriteUncertainError("The result is unknown. Check MyFundedPerps before trying again.");
      controller.abort(error);
      reject(error);
    }, 40_000);
  });
  try {
    // Reply on time even if a database operation is still waiting. The signal prevents a late send.
    return await Promise.race([writeDeadline.run(controller.signal, run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
