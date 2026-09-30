import { setTimeout as sleep } from "node:timers/promises";

export const INPUT_NOT_DELIVERED = "INPUT_NOT_DELIVERED";

// Input normally reaches the page before the browser acknowledges it, so
// these re-checks only cover a late delivery.
const RECHECK_DELAYS_MS = [50, 150];

// A browser can acknowledge input it never delivers: Chrome has been seen
// dropping every CDP input event to a tab after a navigation while still
// reporting success. So send the input and check with the probe the page
// script armed that it arrived. If it did not, and the probe can be sure of
// that, recover and send it once more. Input that still does not arrive is
// reported as an error rather than a success that did nothing. When the
// probe cannot be sure, because page listeners might have hidden the input,
// it is not sent again, so an action is never repeated.
//
// readProbe(disarm) returns the probe reading ({ delivered, conclusive,
// node }), or null when delivery cannot be checked, for example because the
// page navigated away. The page removes the probe once input arrives;
// disarm removes it when giving up.
export async function sendCheckedInput({ send, readProbe, recover, describe }) {
  let settled = false;
  const settle = (reading, resent) => {
    settled = true;
    return { node: reading?.node ?? null, resent };
  };

  let resent = false;
  try {
    await send();
    let reading = await awaitDelivery(readProbe);
    if (reading.delivered) {
      return settle(reading, false);
    }

    if (reading.conclusive) {
      await recover?.();
      // The first input may have arrived, or the page navigated, while
      // recovering; sending again then would repeat it or reach another page.
      reading = (await readProbe(false)) ?? { delivered: true };
      if (reading.delivered) {
        return settle(reading, false);
      }

      await send();
      resent = true;
      reading = await awaitDelivery(readProbe);
      if (reading.delivered) {
        return settle(reading, true);
      }
    }
  } finally {
    if (!settled) {
      await readProbe(true);
    }
  }

  const error = new Error(
    resent
      ? `${describe} was sent twice, but the browser delivered no input events to the page, so it had no effect. The tab may not be accepting input yet, for example just after a navigation. Wait and try again, or act from the page with evaluate_js (for example element.click()).`
      : `${describe} was sent, but no input events reached the page, so it most likely had no effect. It was not sent again, because a page listener may have hidden it. Check the page; if nothing changed, wait and try again, or act from the page with evaluate_js (for example element.click()).`,
  );
  error.code = INPUT_NOT_DELIVERED;
  throw error;
}

// The reading once the input has arrived or the re-checks are used up. A
// probe that cannot be read counts as delivered.
async function awaitDelivery(readProbe) {
  let reading;
  for (const delay of [0, ...RECHECK_DELAYS_MS]) {
    if (delay) {
      await sleep(delay);
    }
    reading = (await readProbe(false)) ?? { delivered: true };
    if (reading.delivered) {
      break;
    }
  }
  return reading;
}
