import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.mjs";
import { createBrowserAdapter } from "./browser-adapter.mjs";
import { CdpSessionManager } from "./cdp-client.mjs";
import { FirefoxBidiSessionManager } from "./firefox-bidi-client.mjs";

test("createBrowserAdapter selects the Chromium adapter by default", () => {
  const adapter = createBrowserAdapter(loadConfig({}));
  assert.equal(adapter instanceof CdpSessionManager, true);
});

test("createBrowserAdapter selects the Firefox BiDi adapter when requested", () => {
  const adapter = createBrowserAdapter(
    loadConfig({
      MCP_BROWSER_FAMILY: "firefox",
    }),
  );

  assert.equal(adapter instanceof FirefoxBidiSessionManager, true);
});
