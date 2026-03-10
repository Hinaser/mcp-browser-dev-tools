import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWaitForOptions, waitForPageCondition } from "./wait-for.mjs";

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
