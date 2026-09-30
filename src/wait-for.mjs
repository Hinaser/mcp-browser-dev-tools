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

function hasTextCondition(options) {
  return (
    options.textEquals !== null ||
    options.textIncludes !== null ||
    options.textExcludes !== null
  );
}

function textChecksFor(condition) {
  return {
    textEquals: condition.textEquals,
    textIncludes: condition.textIncludes,
    textExcludes: condition.textExcludes,
  };
}

function textMatches(result, options, checkIndex) {
  if (!hasTextCondition(options)) {
    return true;
  }

  if (!result?.found) {
    return false;
  }

  // The page compares the full text when it supports textChecks.
  if (Array.isArray(result.textMatches)) {
    return result.textMatches[checkIndex] === true;
  }

  // Clipped text is only a prefix, so it can never prove equality or that a
  // string is absent.
  const { text, clipped } = readElementText(result);
  return (
    (options.textEquals === null ||
      (!clipped && text === options.textEquals)) &&
    (options.textIncludes === null || text.includes(options.textIncludes)) &&
    (options.textExcludes === null ||
      (!clipped && !text.includes(options.textExcludes)))
  );
}

// Expression conditions evaluate in the page's main world and hold when the
// result, awaited if it is a promise, is truthy.
export const DEFAULT_EXPRESSION_TIMEOUT_MS = 5_000;
const EXPRESSION_TIMEOUT = "EXPRESSION_TIMEOUT";

// The page gives up on its own after timeoutMs, so a promise that never
// settles does not leave the evaluation pending in the browser. Node waits a
// little longer as a backstop, since hidden tabs can run timers late.
const EXPRESSION_PAGE_TIMEOUT = "__mcpExpressionTimeout";
const EXPRESSION_BACKSTOP_GRACE_MS = 2_000;

// The expression is passed in as a function defined at the top level, so it
// sees only page globals, never the wrapper's own variables. Only the wrapper
// can produce the timeout marker, since the expression's result is converted
// to a boolean.
function conditionExpression(expression, timeoutMs) {
  return `(async (check, timeoutMs) => {
  const timedOut = {};
  const value = await Promise.race([
    check(),
    new Promise((resolve) => {
      setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  return value === timedOut ? ${JSON.stringify(EXPRESSION_PAGE_TIMEOUT)} : Boolean(value);
})(async () => (
${expression}
), ${timeoutMs})`;
}

function exceptionMessage(details) {
  const description = details?.exception?.description;
  if (typeof description === "string" && description.trim()) {
    return description.split("\n")[0];
  }
  if (typeof details?.text === "string" && details.text.trim()) {
    return details.text;
  }
  const value = details?.exception?.value;
  return value === undefined ? "unknown error" : String(value);
}

async function evaluateCondition(evaluate, expression, timeoutMs) {
  if (typeof evaluate !== "function") {
    throw new Error("expression conditions are not available here");
  }
  const unsettled = () => {
    const error = new Error(
      `expression ${JSON.stringify(expression)} did not settle within ${timeoutMs}ms`,
    );
    error.code = EXPRESSION_TIMEOUT;
    return error;
  };
  let timer;
  const backstop = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(unsettled()),
      timeoutMs + EXPRESSION_BACKSTOP_GRACE_MS,
    );
  });
  try {
    const result = await Promise.race([
      evaluate(conditionExpression(expression, timeoutMs)),
      backstop,
    ]);
    if (result?.exceptionDetails) {
      throw new Error(
        `expression ${JSON.stringify(expression)} threw: ${exceptionMessage(result.exceptionDetails)}`,
      );
    }
    if (result?.result === EXPRESSION_PAGE_TIMEOUT) {
      throw unsettled();
    }
    return result?.result === true;
  } finally {
    clearTimeout(timer);
  }
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

function describeWanted(options) {
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
  if (options.textExcludes !== null) {
    conditions.push(`text to exclude ${JSON.stringify(options.textExcludes)}`);
  }
  if (options.expression) {
    conditions.push(
      `expression ${JSON.stringify(options.expression)} to be truthy`,
    );
  }
  return conditions.join(", ");
}

function describeObserved(options, lastPage, lastElement, lastExpression) {
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
  if (hasTextCondition(options) && lastElement?.found) {
    observed.push(`last text=${JSON.stringify(elementText(lastElement))}`);
  }
  if (options.expression && typeof lastExpression === "boolean") {
    observed.push(`last expression=${lastExpression}`);
  }
  return observed;
}

function buildTimeoutMessage(normalized, lastCheck) {
  const prefix = `Timed out after ${normalized.timeoutMs}ms waiting for `;
  if (!normalized.anyOf) {
    const observed = describeObserved(
      normalized,
      lastCheck?.page,
      lastCheck?.element,
      lastCheck?.expression,
    );
    return `${prefix}${describeWanted(normalized)}${
      observed.length > 0 ? `; ${observed.join("; ")}` : ""
    }`;
  }

  const alternatives = normalized.anyOf.map((condition, index) => {
    const check = lastCheck?.alternatives?.[index];
    const observed = describeObserved(
      condition,
      check?.page,
      check?.element,
      check?.expression,
    );
    return `anyOf[${index}] ${describeWanted(condition)}${
      observed.length > 0 ? ` (${observed.join("; ")})` : ""
    }`;
  });
  return `${prefix}any of: ${alternatives.join("; or ")}`;
}

const CONDITION_KEYS = [
  "selector",
  "state",
  "url",
  "urlIncludes",
  "readyState",
  "textEquals",
  "textIncludes",
  "textExcludes",
  "expression",
];

function normalizeOptionalText(value) {
  return typeof value === "string" ? normalizeText(value) : null;
}

function normalizeCondition(options, label) {
  if (options.anyOf !== undefined) {
    throw new Error(`${label} cannot nest anyOf`);
  }

  const normalized = {
    selector: normalizeOptionalString(options.selector),
    state: normalizeSelectorState(options.state),
    url: normalizeOptionalString(options.url),
    urlIncludes: normalizeOptionalString(options.urlIncludes),
    readyState: normalizeReadyState(options.readyState),
    textEquals: normalizeOptionalText(options.textEquals),
    textIncludes: normalizeOptionalText(options.textIncludes),
    textExcludes: normalizeOptionalText(options.textExcludes),
    expression: normalizeOptionalString(options.expression),
  };

  if (
    !normalized.selector &&
    !normalized.url &&
    !normalized.urlIncludes &&
    !normalized.readyState &&
    !normalized.expression
  ) {
    throw new Error(
      `${label} requires at least one of selector, url, urlIncludes, readyState, or expression`,
    );
  }

  if (!normalized.selector && options.state !== undefined) {
    throw new Error(`${label} state requires selector`);
  }

  if (hasTextCondition(normalized) && !normalized.selector) {
    throw new Error(
      `${label} textEquals, textIncludes, and textExcludes require selector`,
    );
  }

  if (hasTextCondition(normalized) && normalized.state === "hidden") {
    throw new Error(
      `${label} textEquals, textIncludes, and textExcludes cannot be combined with state hidden`,
    );
  }

  return normalized;
}

// Returns either one condition or { anyOf: [conditions] }, plus timing.
export function normalizeWaitForOptions(options = {}, label = "wait_for") {
  const timing = {
    timeoutMs: normalizeInteger(options.timeoutMs, 10_000),
    pollIntervalMs: normalizeInteger(options.pollIntervalMs, 100),
  };
  if (options.anyOf === undefined) {
    return { ...normalizeCondition(options, label), ...timing };
  }

  if (!Array.isArray(options.anyOf) || options.anyOf.length === 0) {
    throw new Error(`${label} anyOf must list at least one condition`);
  }
  const mixed = CONDITION_KEYS.filter((key) => options[key] !== undefined);
  if (mixed.length > 0) {
    throw new Error(
      `${label} anyOf cannot be combined with ${mixed.join(", ")}; put them inside each anyOf condition`,
    );
  }
  return {
    anyOf: options.anyOf.map((condition, index) =>
      normalizeCondition(condition ?? {}, `${label}.anyOf[${index}]`),
    ),
    ...timing,
  };
}

async function checkOneCondition(
  condition,
  readPage,
  readElement,
  readExpression,
) {
  let checkIndex = -1;
  const page =
    condition.url || condition.urlIncludes || condition.readyState
      ? await readPage()
      : null;
  let element = null;
  if (condition.selector) {
    let textChecks;
    ({ element, textChecks } = await readElement(condition.selector));
    checkIndex = textChecks.indexOf(JSON.stringify(textChecksFor(condition)));
    if (element?.error) {
      throw new Error(element.error);
    }
  }

  const matched =
    (condition.selector
      ? selectorMatches(element, condition.state) &&
        textMatches(element, condition, checkIndex)
      : true) &&
    (condition.url ? page?.url === condition.url : true) &&
    (condition.urlIncludes
      ? page?.url?.includes(condition.urlIncludes) === true
      : true) &&
    (condition.readyState
      ? readyStateMatches(page?.readyState, condition.readyState)
      : true);
  const expression = condition.expression
    ? await readExpression(condition.expression)
    : null;

  return {
    matched: matched && (condition.expression ? expression : true),
    page,
    element,
    text: element?.found ? elementText(element) : null,
    expression,
  };
}

// Checks normalized conditions once against the current page. For anyOf, the
// alternatives are checked in order until one holds, reading the page state
// and each selector at most once. Expressions must settle by deadline.
export async function checkPageCondition({
  getPageState,
  inspectElement,
  evaluate,
  normalized,
  deadline = Date.now() + DEFAULT_EXPRESSION_TIMEOUT_MS,
}) {
  let pagePromise = null;
  const readPage = () => {
    pagePromise ??= getPageState();
    return pagePromise;
  };
  const expressions = new Map();
  const readExpression = (expression) => {
    if (!expressions.has(expression)) {
      expressions.set(
        expression,
        evaluateCondition(
          evaluate,
          expression,
          Math.max(1, deadline - Date.now()),
        ),
      );
    }
    return expressions.get(expression);
  };
  // Gather every text check per selector first, so one inspection per
  // selector answers all of them.
  const conditions = normalized.anyOf ?? [normalized];
  const textChecks = new Map();
  for (const condition of conditions) {
    if (!condition.selector || !hasTextCondition(condition)) {
      continue;
    }
    const checks = textChecks.get(condition.selector) ?? [];
    const key = JSON.stringify(textChecksFor(condition));
    if (!checks.includes(key)) {
      checks.push(key);
    }
    textChecks.set(condition.selector, checks);
  }
  const elements = new Map();
  const readElement = (selector) => {
    if (!elements.has(selector)) {
      const checks = textChecks.get(selector) ?? [];
      elements.set(
        selector,
        (checks.length > 0
          ? inspectElement(selector, {
              textChecks: checks.map((key) => JSON.parse(key)),
            })
          : inspectElement(selector)
        ).then((element) => ({ element, textChecks: checks })),
      );
    }
    return elements.get(selector);
  };

  if (!normalized.anyOf) {
    return checkOneCondition(normalized, readPage, readElement, readExpression);
  }

  const alternatives = [];
  for (const condition of normalized.anyOf) {
    const check = await checkOneCondition(
      condition,
      readPage,
      readElement,
      readExpression,
    );
    alternatives.push(check);
    if (check.matched) {
      return {
        ...check,
        matchedIndex: alternatives.length - 1,
        alternatives,
      };
    }
  }
  return {
    matched: false,
    page: null,
    element: null,
    text: null,
    expression: null,
    matchedIndex: null,
    alternatives,
  };
}

function describeCondition(condition) {
  return {
    selector: condition.selector,
    state: condition.selector ? condition.state : null,
    url: condition.url,
    urlIncludes: condition.urlIncludes,
    readyState: condition.readyState,
    textEquals: condition.textEquals,
    textIncludes: condition.textIncludes,
    textExcludes: condition.textExcludes,
    ...(condition.expression ? { expression: condition.expression } : {}),
  };
}

export async function waitForPageCondition({
  getPageState,
  inspectElement,
  evaluate,
  options,
}) {
  const normalized = normalizeWaitForOptions(options);
  const startedAt = Date.now();
  let attempts = 0;
  let lastCheck = null;

  while (true) {
    attempts += 1;

    let check;
    try {
      check = await checkPageCondition({
        getPageState,
        inspectElement,
        evaluate,
        normalized,
        deadline: startedAt + normalized.timeoutMs,
      });
    } catch (error) {
      // An expression cut off by the deadline after earlier polls completed
      // is an ordinary timeout; report what those polls observed.
      if (error.code === EXPRESSION_TIMEOUT && lastCheck) {
        throw new Error(buildTimeoutMessage(normalized, lastCheck), {
          cause: error,
        });
      }
      throw error;
    }
    lastCheck = check;

    if (check.matched) {
      const matchedCondition = normalized.anyOf
        ? normalized.anyOf[check.matchedIndex]
        : normalized;
      const lastPage = check.page;
      const lastElement = check.element;
      const browserFamily =
        lastPage?.browserFamily ?? lastElement?.browserFamily ?? null;

      return {
        browserFamily,
        matched: true,
        ...(normalized.anyOf ? { matchedIndex: check.matchedIndex } : {}),
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs: normalized.timeoutMs,
        pollIntervalMs: normalized.pollIntervalMs,
        condition: normalized.anyOf
          ? { anyOf: normalized.anyOf.map(describeCondition) }
          : describeCondition(normalized),
        page: lastPage,
        element: matchedCondition.selector
          ? {
              selector: matchedCondition.selector,
              found: Boolean(lastElement?.found),
              locator:
                lastElement?.locator ?? lastElement?.node?.locator ?? null,
              node: lastElement?.found ? lastElement.node : null,
            }
          : null,
      };
    }

    if (Date.now() - startedAt >= normalized.timeoutMs) {
      throw new Error(buildTimeoutMessage(normalized, check));
    }

    await sleep(normalized.pollIntervalMs);
  }
}
