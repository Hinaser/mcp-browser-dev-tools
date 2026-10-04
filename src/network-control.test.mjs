import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNetworkOptions,
  describeNetworkState,
  globToRegExp,
  mockHeaders,
  takeMatchingRule,
} from "./network-control.mjs";

test("globToRegExp follows CDP's Fetch pattern syntax", () => {
  const ads = globToRegExp("*://*/ads/*");
  assert.equal(ads.test("https://example.com/ads/banner.js"), true);
  assert.equal(ads.test("https://example.com/api/ads"), false);
  assert.equal(globToRegExp("*/item?.json").test("https://a/item7.json"), true);
  assert.equal(
    globToRegExp("*/item?.json").test("https://a/item77.json"),
    false,
  );
  // Regex characters are literal, and a backslash escapes a wildcard.
  assert.equal(globToRegExp("*/a+b(1).js").test("https://a/a+b(1).js"), true);
  assert.equal(globToRegExp("*/what\\?").test("https://a/what?"), true);
  assert.equal(globToRegExp("*/what\\?").test("https://a/whatx"), false);
});

test("a set_network call replaces the fields it gives, and rules count hits", () => {
  const first = applyNetworkOptions(null, {
    rules: [
      { url: "*/ads/*", action: "block" },
      {
        url: "*/api/*",
        action: "mock",
        body: "{}",
        contentType: "application/json",
      },
    ],
    headers: { "X-Test": "1" },
  });
  assert.equal(takeMatchingRule(first, "https://a/ads/x.js").action, "block");
  assert.equal(takeMatchingRule(first, "https://a/api/data").action, "mock");
  assert.equal(takeMatchingRule(first, "https://a/other"), null);

  const second = applyNetworkOptions(first, { latencyMs: 300 });
  assert.deepEqual(describeNetworkState(second), {
    rules: [
      { url: "*/ads/*", action: "block", hits: 1 },
      { url: "*/api/*", action: "mock", status: 200, hits: 1 },
    ],
    headers: ["X-Test"],
    offline: false,
    latencyMs: 300,
    downloadKbps: null,
    uploadKbps: null,
  });

  const reset = applyNetworkOptions(second, { reset: true, offline: true });
  assert.deepEqual(describeNetworkState(reset), {
    rules: [],
    headers: [],
    offline: true,
  });
});

test("mock responses allow CORS unless the rule sets it", () => {
  const [rule] = applyNetworkOptions(null, {
    rules: [{ url: "*", action: "mock", contentType: "text/plain" }],
  }).rules;
  assert.deepEqual(mockHeaders(rule), [
    { name: "content-type", value: "text/plain" },
    { name: "access-control-allow-origin", value: "*" },
  ]);

  const [own] = applyNetworkOptions(null, {
    rules: [
      {
        url: "*",
        action: "mock",
        headers: { "Access-Control-Allow-Origin": "https://a" },
      },
    ],
  }).rules;
  assert.deepEqual(mockHeaders(own), [
    { name: "Access-Control-Allow-Origin", value: "https://a" },
  ]);
});

test("set_network rejects header names and values a browser would refuse", () => {
  assert.throws(
    () => applyNetworkOptions(null, { headers: { "Bad Header": "x" } }),
    /invalid header name/,
  );
  assert.throws(
    () =>
      applyNetworkOptions(null, { headers: { "X-Ok": "a\r\nInjected: 1" } }),
    /line break/,
  );
});

test("a mock's contentType is checked like its headers", () => {
  assert.throws(
    () =>
      applyNetworkOptions(null, {
        rules: [
          { url: "*", action: "mock", contentType: "text/plain\r\nX-Bad: 1" },
        ],
      }),
    /line break/,
  );
});
