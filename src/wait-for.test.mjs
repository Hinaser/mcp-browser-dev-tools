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
    /requires at least one of selector, url, urlIncludes, or readyState/,
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
    /textEquals and textIncludes require selector/,
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
});
