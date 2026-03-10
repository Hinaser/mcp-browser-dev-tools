function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const READY_STATE_ORDER = {
  loading: 0,
  interactive: 1,
  complete: 2,
};

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSelectorState(value) {
  if (value === "present" || value === "visible" || value === "hidden") {
    return value;
  }

  return "visible";
}

function normalizeReadyState(value) {
  if (value === "interactive" || value === "complete") {
    return value;
  }

  return null;
}

function normalizeInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readyStateMatches(current, expected) {
  const currentRank = READY_STATE_ORDER[current] ?? -1;
  const expectedRank = READY_STATE_ORDER[expected] ?? -1;
  return currentRank >= expectedRank;
}

function selectorMatches(result, state) {
  if (state === "hidden") {
    return !result?.found || result.node?.visible === false;
  }

  if (!result?.found) {
    return false;
  }

  if (state === "present") {
    return true;
  }

  return result.node?.visible === true;
}

function buildTimeoutMessage(options, lastPage, lastElement) {
  const conditions = [];
  if (options.selector) {
    conditions.push(
      `selector ${JSON.stringify(options.selector)} to become ${options.state}`,
    );
  }
  if (options.url) {
    conditions.push(`url to equal ${JSON.stringify(options.url)}`);
  }
  if (options.urlIncludes) {
    conditions.push(`url to include ${JSON.stringify(options.urlIncludes)}`);
  }
  if (options.readyState) {
    conditions.push(`readyState to reach ${options.readyState}`);
  }

  const observed = [];
  if (lastPage?.url) {
    observed.push(`last url=${JSON.stringify(lastPage.url)}`);
  }
  if (lastPage?.readyState) {
    observed.push(`last readyState=${lastPage.readyState}`);
  }
  if (options.selector && lastElement) {
    observed.push(
      `last selector found=${Boolean(lastElement.found)} visible=${lastElement.node?.visible === true}`,
    );
  }

  return `Timed out after ${options.timeoutMs}ms waiting for ${conditions.join(
    ", ",
  )}${observed.length > 0 ? `; ${observed.join("; ")}` : ""}`;
}

export function normalizeWaitForOptions(options = {}) {
  const normalized = {
    selector: normalizeOptionalString(options.selector),
    state: normalizeSelectorState(options.state),
    url: normalizeOptionalString(options.url),
    urlIncludes: normalizeOptionalString(options.urlIncludes),
    readyState: normalizeReadyState(options.readyState),
    timeoutMs: normalizeInteger(options.timeoutMs, 10_000),
    pollIntervalMs: normalizeInteger(options.pollIntervalMs, 100),
  };

  if (
    !normalized.selector &&
    !normalized.url &&
    !normalized.urlIncludes &&
    !normalized.readyState
  ) {
    throw new Error(
      "wait_for requires at least one of selector, url, urlIncludes, or readyState",
    );
  }

  if (!normalized.selector && options.state !== undefined) {
    throw new Error("wait_for state requires selector");
  }

  return normalized;
}

export async function waitForPageCondition({
  getPageState,
  inspectElement,
  options,
}) {
  const normalized = normalizeWaitForOptions(options);
  const startedAt = Date.now();
  let attempts = 0;
  let lastPage = null;
  let lastElement = null;

  while (true) {
    attempts += 1;

    if (normalized.url || normalized.urlIncludes || normalized.readyState) {
      lastPage = await getPageState();
    }

    if (normalized.selector) {
      lastElement = await inspectElement(normalized.selector);
      if (lastElement?.error) {
        throw new Error(lastElement.error);
      }
    }

    const matchedSelector = normalized.selector
      ? selectorMatches(lastElement, normalized.state)
      : true;
    const matchedUrl = normalized.url ? lastPage?.url === normalized.url : true;
    const matchedUrlIncludes = normalized.urlIncludes
      ? lastPage?.url?.includes(normalized.urlIncludes) === true
      : true;
    const matchedReadyState = normalized.readyState
      ? readyStateMatches(lastPage?.readyState, normalized.readyState)
      : true;

    if (
      matchedSelector &&
      matchedUrl &&
      matchedUrlIncludes &&
      matchedReadyState
    ) {
      const browserFamily =
        lastPage?.browserFamily ?? lastElement?.browserFamily ?? null;

      return {
        browserFamily,
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs: normalized.timeoutMs,
        pollIntervalMs: normalized.pollIntervalMs,
        condition: {
          selector: normalized.selector,
          state: normalized.selector ? normalized.state : null,
          url: normalized.url,
          urlIncludes: normalized.urlIncludes,
          readyState: normalized.readyState,
        },
        page: lastPage,
        element: normalized.selector
          ? {
              selector: normalized.selector,
              found: Boolean(lastElement?.found),
              locator:
                lastElement?.locator ?? lastElement?.node?.locator ?? null,
              node: lastElement?.found ? lastElement.node : null,
            }
          : null,
      };
    }

    if (Date.now() - startedAt >= normalized.timeoutMs) {
      throw new Error(buildTimeoutMessage(normalized, lastPage, lastElement));
    }

    await sleep(normalized.pollIntervalMs);
  }
}
