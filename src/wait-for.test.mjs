import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPageCondition,
  normalizeWaitForOptions,
  waitForPageCondition,
} from "./wait-for.mjs";

test("normalizeWaitForOptions requires at least one wait condition", () => {
  assert.throws(
    () => normalizeWaitForOptions({}),
    /requires at least one of selector, url, urlIncludes, readyState, or expression/,
  );
});

test("normalizeWaitForOptions requires selector when state is provided", () => {
  assert.throws(
    () => normalizeWaitForOptions({ state: "visible", url: "https://x.test" }),
    /state requires selector/,
  );
});

test("waitForPageCondition supports hidden selector waits", async () => {
  const result = await waitForPageCondition({
    getPageState: async () => ({
      browserFamily: "chromium",
      url: "https://example.com",
      readyState: "complete",
    }),
    inspectElement: async () => ({
      browserFamily: "chromium",
      selector: "#toast",
      found: false,
      locator: null,
      node: null,
    }),
    options: {
      selector: "#toast",
      state: "hidden",
      timeoutMs: 10,
      pollIntervalMs: 1,
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.element.found, false);
});

test("waitForPageCondition times out with observed state details", async () => {
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({
        browserFamily: "chromium",
        url: "https://example.com/loading",
        readyState: "interactive",
      }),
      inspectElement: async () => ({
        browserFamily: "chromium",
        selector: "#app",
        found: false,
        node: null,
      }),
      options: {
        selector: "#app",
        state: "visible",
        readyState: "complete",
        timeoutMs: 5,
        pollIntervalMs: 1,
      },
    }),
    /Timed out after 5ms/,
  );
});

test("waitForPageCondition matches selector text with collapsed whitespace", async () => {
  const result = await waitForPageCondition({
    getPageState: async () => ({}),
    inspectElement: async () => ({
      found: true,
      node: { visible: true, innerText: "  Order\n  saved  " },
    }),
    options: {
      selector: "#status",
      textEquals: "Order saved",
      textIncludes: "saved",
      timeoutMs: 20,
      pollIntervalMs: 5,
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.condition.textEquals, "Order saved");
});

test("waitForPageCondition reports the last text when a text wait times out", async () => {
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({
        found: true,
        node: { visible: true, innerText: "Saving" },
      }),
      options: {
        selector: "#status",
        textEquals: "Saved",
        timeoutMs: 10,
        pollIntervalMs: 5,
      },
    }),
    /text to equal "Saved".*last text="Saving"/,
  );
});

test("normalizeWaitForOptions validates text conditions", () => {
  assert.throws(
    () => normalizeWaitForOptions({ url: "https://x.test", textEquals: "a" }),
    /textEquals, textIncludes, and textExcludes require selector/,
  );
  assert.throws(
    () =>
      normalizeWaitForOptions({
        selector: "#a",
        state: "hidden",
        textIncludes: "a",
      }),
    /cannot be combined with state hidden/,
  );
  assert.throws(
    () => normalizeWaitForOptions({}, "if condition"),
    /^Error: if condition requires at least one/,
  );
});

test("text conditions ignore the page context clip marker", async () => {
  const clipped = `${"a".repeat(400)}...`;
  const check = (options) =>
    checkPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({
        found: true,
        node: { visible: true, innerText: clipped },
      }),
      normalized: normalizeWaitForOptions({ selector: "#long", ...options }),
    });

  assert.equal((await check({ textIncludes: "..." })).matched, false);
  assert.equal((await check({ textEquals: "a".repeat(400) })).matched, false);
  assert.equal((await check({ textIncludes: "aaa" })).matched, true);
  // Text past the clip could contain the string.
  assert.equal((await check({ textExcludes: "b" })).matched, false);
});

test("textExcludes holds once the text no longer contains the string", async () => {
  const check = (innerText, found = true) =>
    checkPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({
        found,
        node: { visible: true, innerText },
      }),
      normalized: normalizeWaitForOptions({
        selector: "#status",
        textExcludes: "Processing",
      }),
    });

  assert.equal((await check("Processing payment")).matched, false);
  assert.equal((await check("Paid")).matched, true);
  // A missing element has no text to check.
  assert.equal((await check("", false)).matched, false);
});

test("normalizeWaitForOptions validates anyOf", () => {
  assert.throws(
    () => normalizeWaitForOptions({ anyOf: [] }),
    /anyOf must list at least one condition/,
  );
  assert.throws(
    () => normalizeWaitForOptions({ selector: "#a", anyOf: [{ url: "x" }] }),
    /anyOf cannot be combined with selector/,
  );
  assert.throws(
    () =>
      normalizeWaitForOptions({ anyOf: [{ url: "x" }, { state: "visible" }] }),
    /^Error: wait_for\.anyOf\[1\] requires at least one/,
  );
  assert.throws(
    () => normalizeWaitForOptions({ anyOf: [{ anyOf: [{ url: "x" }] }] }),
    /anyOf\[0\] cannot nest anyOf/,
  );
  assert.deepEqual(
    normalizeWaitForOptions({ anyOf: [{ url: "x" }], timeoutMs: 50 }).timeoutMs,
    50,
  );
});

test("waitForPageCondition with anyOf ends on the first alternative that holds", async () => {
  let polls = 0;
  let inspections = 0;
  let pageReads = 0;
  const result = await waitForPageCondition({
    getPageState: async () => {
      pageReads += 1;
      return { url: "https://shop.test/pay", readyState: "complete" };
    },
    inspectElement: async () => {
      inspections += 1;
      polls += 1;
      return {
        found: true,
        node: {
          visible: true,
          innerText: polls < 3 ? "Processing" : "Declined, try again",
        },
      };
    },
    options: {
      anyOf: [
        { selector: "#status", textIncludes: "Paid" },
        { selector: "#status", textIncludes: "Declined" },
        { urlIncludes: "/receipt" },
      ],
      timeoutMs: 1000,
      pollIntervalMs: 1,
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.matchedIndex, 1);
  assert.equal(result.attempts, 3);
  assert.equal(result.element.selector, "#status");
  assert.equal(result.condition.anyOf.length, 3);
  // Each poll reads a selector once even when several alternatives use it.
  assert.equal(inspections, 3);
  // The page state is only read on polls that reach the url alternative.
  assert.equal(pageReads, 2);
});

test("waitForPageCondition with anyOf reports every alternative on timeout", async () => {
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({ url: "https://shop.test/pay" }),
      inspectElement: async () => ({
        found: true,
        node: { visible: true, innerText: "Processing" },
      }),
      options: {
        anyOf: [
          { selector: "#status", textIncludes: "Paid" },
          { urlIncludes: "/receipt" },
        ],
        timeoutMs: 10,
        pollIntervalMs: 5,
      },
    }),
    /any of: anyOf\[0\] selector "#status".*last text="Processing".*; or anyOf\[1\] url to include "\/receipt" \(last url="https:\/\/shop\.test\/pay"\)/,
  );
});

test("checkPageCondition asks the page for text checks once per selector", async () => {
  const requests = [];
  const check = await checkPageCondition({
    getPageState: async () => ({}),
    inspectElement: async (selector, options) => {
      requests.push({ selector, options });
      // A clipped node, as the page returns for long text; only textMatches
      // decides the outcome.
      return {
        found: true,
        node: { visible: true, innerText: `${"a".repeat(400)}...` },
        textMatches: [false, true],
      };
    },
    normalized: normalizeWaitForOptions({
      anyOf: [
        { selector: "#status", textIncludes: "Paid" },
        { selector: "#status", textExcludes: "Processing" },
        { selector: "#status", textIncludes: "Paid" },
      ],
    }),
  });

  assert.equal(check.matched, true);
  assert.equal(check.matchedIndex, 1);
  assert.deepEqual(requests, [
    {
      selector: "#status",
      options: {
        textChecks: [
          { textEquals: null, textIncludes: "Paid", textExcludes: null },
          { textEquals: null, textIncludes: null, textExcludes: "Processing" },
        ],
      },
    },
  ]);
});

function expressionEvaluator(results) {
  const calls = [];
  return {
    calls,
    evaluate: async (expression) => {
      calls.push(expression);
      const next = results.length > 1 ? results.shift() : results[0];
      return typeof next === "function" ? next() : next;
    },
  };
}

// Runs the generated page code in Node, standing in for the browser.
function runInPage(expression) {
  return (async () => {
    try {
      return { result: await new Function(`return ${expression}`)() };
    } catch (error) {
      return { result: null, exceptionDetails: { text: String(error) } };
    }
  })();
}

test("an expression condition holds once the expression is truthy", async () => {
  const page = expressionEvaluator([
    { result: false, exceptionDetails: null },
    { result: true, exceptionDetails: null },
  ]);
  const result = await waitForPageCondition({
    getPageState: async () => ({}),
    inspectElement: async () => ({ found: false }),
    evaluate: page.evaluate,
    options: {
      expression: "window.appReady === true",
      timeoutMs: 1000,
      pollIntervalMs: 1,
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.condition.expression, "window.appReady === true");
  assert.ok(page.calls[0].includes("\nwindow.appReady === true\n"));
});

test("an expression condition times out with the last result", async () => {
  const page = expressionEvaluator([{ result: false, exceptionDetails: null }]);
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: page.evaluate,
      options: { expression: "rows() > 4", timeoutMs: 5, pollIntervalMs: 1 },
    }),
    /waiting for expression "rows\(\) > 4" to be truthy; last expression=false/,
  );
});

test("an expression that throws fails the wait at once", async () => {
  const page = expressionEvaluator([
    {
      result: null,
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          description:
            "TypeError: Cannot read properties of null (reading 'x')\n    at <anonymous>:2:8",
        },
      },
    },
  ]);
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: page.evaluate,
      options: { expression: "el.x", timeoutMs: 1000, pollIntervalMs: 1 },
    }),
    /expression "el\.x" threw: TypeError: Cannot read properties of null \(reading 'x'\)$/,
  );
  assert.equal(page.calls.length, 1);
});

test("an expression that never settles fails within the wait's timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: runInPage,
      options: {
        expression: "new Promise(() => {})",
        timeoutMs: 30,
        pollIntervalMs: 1,
      },
    }),
    // The message reports the time left, which a slow runner can make 29ms.
    /did not settle within \d+ms/,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("the backstop fails an evaluation the page never answers", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    checkPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: () => new Promise(() => {}),
      normalized: normalizeWaitForOptions({ expression: "true" }),
      deadline: Date.now() + 10,
    }),
    /did not settle within \d+ms/,
  );
  assert.ok(Date.now() - startedAt >= 2000);
});

test("anyOf can mix expression and selector alternatives", async () => {
  const page = expressionEvaluator([{ result: true, exceptionDetails: null }]);
  const check = await checkPageCondition({
    getPageState: async () => ({}),
    inspectElement: async () => ({ found: false }),
    evaluate: page.evaluate,
    normalized: normalizeWaitForOptions({
      anyOf: [
        { selector: "#error" },
        { expression: "document.title === 'Done'" },
        { expression: "document.title === 'Done'", selector: "#done" },
      ],
    }),
  });

  assert.equal(check.matched, true);
  assert.equal(check.matchedIndex, 1);
  assert.equal(check.expression, true);
  assert.equal(page.calls.length, 1);
});

test("expression conditions fail clearly without an evaluator", async () => {
  await assert.rejects(
    checkPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      normalized: normalizeWaitForOptions({ expression: "true" }),
    }),
    /expression conditions are not available here/,
  );
});

test("expressions in anyOf share the wait's deadline", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: runInPage,
      options: {
        anyOf: [
          { expression: "new Promise((r) => setTimeout(() => r(false), 70))" },
          { expression: "new Promise((r) => setTimeout(() => r(true), 70))" },
        ],
        timeoutMs: 100,
        pollIntervalMs: 1,
      },
    }),
    /expression "new Promise\(\(r\) => setTimeout\(\(\) => r\(true\), 70\)\)" did not settle within \d+ms/,
  );
  assert.ok(Date.now() - startedAt < 140);
});

test("an expression cut off by the deadline after earlier polls reports a timeout", async () => {
  globalThis.polls = 0;
  await assert.rejects(
    waitForPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: runInPage,
      options: {
        expression: "++globalThis.polls > 1 ? new Promise(() => {}) : false",
        timeoutMs: 30,
        pollIntervalMs: 1,
      },
    }),
    /^Error: Timed out after 30ms waiting for expression ".*" to be truthy; last expression=false$/,
  );
  delete globalThis.polls;
});

test("expressions see page globals, not the wrapper's variables", async () => {
  for (const name of ["check", "timeoutMs", "timedOut", "value", "result"]) {
    globalThis[name] = { ready: true };
    const check = await checkPageCondition({
      getPageState: async () => ({}),
      inspectElement: async () => ({ found: false }),
      evaluate: runInPage,
      normalized: normalizeWaitForOptions({ expression: `${name}.ready` }),
    });
    delete globalThis[name];
    assert.equal(check.matched, true, name);
  }
});

test("an expression returning the timeout marker text still holds", async () => {
  const check = await checkPageCondition({
    getPageState: async () => ({}),
    inspectElement: async () => ({ found: false }),
    evaluate: runInPage,
    normalized: normalizeWaitForOptions({
      expression: "'__mcpExpressionTimeout'",
    }),
  });
  assert.equal(check.matched, true);
});
