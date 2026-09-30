import { ELEMENT_NOT_ACTIONABLE } from "./page-context.mjs";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const DEFAULT_ACTION_TIMEOUT_MS = 2000;

export const ACTION_RETRY_MS = 100;

// Retries an action while its element is missing or not yet usable, so a
// batch survives a late banner or a control that is enabled a moment later.
// Invalid selectors and other errors fail at once. Retried errors come from
// checks made before any input is sent, so a retry never repeats an action.
export async function retryUntilActionable(action, timeoutMs) {
  const limit = timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const startedAt = Date.now();
  let retried = false;
  while (true) {
    let result;
    let error = null;
    try {
      result = await action();
    } catch (caught) {
      if (caught?.code !== ELEMENT_NOT_ACTIONABLE) {
        throw caught;
      }
      error = caught;
    }

    const missing = !error && result?.found === false && !result.error;
    const waitedMs = Date.now() - startedAt;
    const done = (!error && !missing) || waitedMs >= limit;
    if (done) {
      if (error) {
        if (retried) {
          error.message += ` (still failing after ${waitedMs}ms)`;
        }
        throw error;
      }
      return retried && result && typeof result === "object"
        ? { ...result, waitedMs }
        : result;
    }
    retried = true;
    await sleep(Math.min(ACTION_RETRY_MS, limit - waitedMs));
  }
}
