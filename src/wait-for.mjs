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

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// Text conditions compare whitespace-normalized visible text, which the page
// context clips to 400 characters and marks with a trailing "...".
const PAGE_TEXT_LIMIT = 400;
const CLIP_MARKER = "...";

function readElementText(result) {
  const raw = result?.node?.innerText ?? result?.node?.textContent;
  const clipped =
    typeof raw === "string" &&
    raw.length === PAGE_TEXT_LIMIT + CLIP_MARKER.length &&
    raw.endsWith(CLIP_MARKER);
  return {
    text: normalizeText(clipped ? raw.slice(0, PAGE_TEXT_LIMIT) : raw),
    clipped,
  };
}

function elementText(result) {
  return readElementText(result).text;
}

function textMatches(result, options) {
  if (options.textEquals === null && options.textIncludes === null) {
    return true;
  }

  if (!result?.found) {
    return false;
  }

  // Clipped text is only a prefix, so it can never prove equality.
  const { text, clipped } = readElementText(result);
  return (
    (options.textEquals === null ||
      (!clipped && text === options.textEquals)) &&
    (options.textIncludes === null || text.includes(options.textIncludes))
  );
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
  if (options.textEquals !== null) {
    conditions.push(`text to equal ${JSON.stringify(options.textEquals)}`);
  }
  if (options.textIncludes !== null) {
    conditions.push(`text to include ${JSON.stringify(options.textIncludes)}`);
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
  if (
    (options.textEquals !== null || options.textIncludes !== null) &&
    lastElement?.found
  ) {
    observed.push(`last text=${JSON.stringify(elementText(lastElement))}`);
  }

  return `Timed out after ${options.timeoutMs}ms waiting for ${conditions.join(
    ", ",
  )}${observed.length > 0 ? `; ${observed.join("; ")}` : ""}`;
}

export function normalizeWaitForOptions(options = {}, label = "wait_for") {
  const normalized = {
    selector: normalizeOptionalString(options.selector),
    state: normalizeSelectorState(options.state),
    url: normalizeOptionalString(options.url),
    urlIncludes: normalizeOptionalString(options.urlIncludes),
    readyState: normalizeReadyState(options.readyState),
    textEquals:
      typeof options.textEquals === "string"
        ? normalizeText(options.textEquals)
        : null,
    textIncludes:
      typeof options.textIncludes === "string"
        ? normalizeText(options.textIncludes)
        : null,
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
      `${label} requires at least one of selector, url, urlIncludes, or readyState`,
    );
  }

  if (!normalized.selector && options.state !== undefined) {
    throw new Error(`${label} state requires selector`);
  }

  const hasText =
    normalized.textEquals !== null || normalized.textIncludes !== null;
  if (hasText && !normalized.selector) {
    throw new Error(`${label} textEquals and textIncludes require selector`);
  }

  if (hasText && normalized.state === "hidden") {
    throw new Error(
      `${label} textEquals and textIncludes cannot be combined with state hidden`,
    );
  }

  return normalized;
}

// Checks normalized conditions once against the current page.
export async function checkPageCondition({
  getPageState,
  inspectElement,
  normalized,
}) {
  let page = null;
  let element = null;
  if (normalized.url || normalized.urlIncludes || normalized.readyState) {
    page = await getPageState();
  }

  if (normalized.selector) {
    element = await inspectElement(normalized.selector);
    if (element?.error) {
      throw new Error(element.error);
    }
  }

  const matched =
    (normalized.selector
      ? selectorMatches(element, normalized.state) &&
        textMatches(element, normalized)
      : true) &&
    (normalized.url ? page?.url === normalized.url : true) &&
    (normalized.urlIncludes
      ? page?.url?.includes(normalized.urlIncludes) === true
      : true) &&
    (normalized.readyState
      ? readyStateMatches(page?.readyState, normalized.readyState)
      : true);

  return {
    matched,
    page,
    element,
    text: element?.found ? elementText(element) : null,
  };
}

export async function waitForPageCondition({
  getPageState,
  inspectElement,
  options,
}) {
  const normalized = normalizeWaitForOptions(options);
  const startedAt = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;

    const check = await checkPageCondition({
      getPageState,
      inspectElement,
      normalized,
    });
    const lastPage = check.page;
    const lastElement = check.element;

    if (check.matched) {
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
          textEquals: normalized.textEquals,
          textIncludes: normalized.textIncludes,
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
