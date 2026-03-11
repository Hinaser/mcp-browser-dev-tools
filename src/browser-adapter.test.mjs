import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.mjs";
import {
  createBrowserAdapter,
  MultiBrowserAdapter,
} from "./browser-adapter.mjs";
import { CdpSessionManager } from "./cdp-client.mjs";
import { FirefoxBidiSessionManager } from "./firefox-bidi-client.mjs";

function createFakeAdapter(browserFamily) {
  return {
    async getBrowserStatus() {
      return {
        available: true,
        browserFamily,
        sessionCount: 1,
      };
    },
    async listTargets() {
      return [
        {
          targetId: `${browserFamily}-tab`,
          title: `${browserFamily} tab`,
          url: `https://${browserFamily}.example.com`,
        },
      ];
    },
    listSessions() {
      return [
        {
          sessionId: `${browserFamily}-session`,
          targetId: `${browserFamily}-tab`,
          title: `${browserFamily} tab`,
        },
      ];
    },
    async createTab(url = "about:blank") {
      return {
        browserFamily,
        targetId: `${browserFamily}-new-tab`,
        title: `${browserFamily} new tab`,
        url,
      };
    },
    async closeTarget(targetId) {
      return {
        browserFamily,
        closed: true,
        targetId,
        detachedSessions: [{ sessionId: `${browserFamily}-session` }],
      };
    },
    async attachToTarget(targetId) {
      return {
        sessionId: `${browserFamily}-attached`,
        targetId,
      };
    },
    async getPageState(sessionId) {
      return {
        sessionId,
        targetId: `${browserFamily}-tab`,
        browserFamily,
      };
    },
    async waitFor(sessionId, options) {
      return {
        sessionId,
        browserFamily,
        matched: true,
        condition: options,
      };
    },
    async getCookies(sessionId) {
      return {
        sessionId,
        browserFamily,
        cookies: { totalEntries: 1, entries: [{ name: "sid" }] },
      };
    },
    async getStorage(sessionId) {
      return {
        sessionId,
        browserFamily,
        storage: {
          localStorage: { totalEntries: 1 },
          sessionStorage: { totalEntries: 0 },
        },
      };
    },
    async captureDebugReport(sessionId, options) {
      return {
        sessionId,
        browserFamily,
        options,
        page: { url: `https://${browserFamily}.example.com` },
      };
    },
    async captureSessionSnapshot(sessionId) {
      return {
        sessionId,
        browserFamily,
        page: { url: `https://${browserFamily}.example.com` },
      };
    },
    async restoreSessionSnapshot(sessionId, snapshot, options) {
      return {
        sessionId,
        browserFamily,
        snapshot,
        options,
      };
    },
    getHar(sessionId, options) {
      return {
        sessionId,
        browserFamily,
        options,
        log: { version: "1.2", entries: [] },
      };
    },
    async closeAll() {},
  };
}

test("createBrowserAdapter selects the multiplex adapter by default", () => {
  const adapter = createBrowserAdapter(loadConfig({}));
  assert.equal(adapter instanceof MultiBrowserAdapter, true);
});

test("createBrowserAdapter selects the Firefox BiDi adapter when requested", () => {
  const adapter = createBrowserAdapter(
    loadConfig({
      MCP_BROWSER_FAMILY: "firefox",
    }),
  );

  assert.equal(adapter instanceof FirefoxBidiSessionManager, true);
});

test("createBrowserAdapter selects the CDP adapter for Edge", () => {
  const adapter = createBrowserAdapter(
    loadConfig({
      MCP_BROWSER_FAMILY: "edge",
    }),
  );

  assert.equal(adapter instanceof CdpSessionManager, true);
});

test("createBrowserAdapter selects the multiplex adapter in auto mode", () => {
  const adapter = createBrowserAdapter(
    loadConfig({
      MCP_BROWSER_FAMILY: "auto",
    }),
  );

  assert.equal(adapter instanceof MultiBrowserAdapter, true);
});

test("MultiBrowserAdapter merges browser status across adapters", async () => {
  const adapter = new MultiBrowserAdapter({
    chromium: createFakeAdapter("chromium"),
    firefox: createFakeAdapter("firefox"),
  });

  const status = await adapter.getBrowserStatus();

  assert.equal(status.available, true);
  assert.equal(status.browserFamily, "auto");
  assert.deepEqual(status.availableBrowsers, ["chromium", "firefox"]);
  assert.equal(status.sessionCount, 2);
  assert.equal(status.browsers.chromium.available, true);
  assert.equal(status.browsers.firefox.available, true);
});

test("MultiBrowserAdapter prefixes target and session identifiers", async () => {
  const adapter = new MultiBrowserAdapter({
    chromium: createFakeAdapter("chromium"),
    firefox: createFakeAdapter("firefox"),
  });

  const tabs = await adapter.listTargets();
  assert.deepEqual(
    tabs.map((tab) => tab.targetId),
    ["chromium:chromium-tab", "firefox:firefox-tab"],
  );

  const session = await adapter.attachToTarget("firefox:firefox-tab");
  assert.equal(session.sessionId, "firefox:firefox-attached");
  assert.equal(session.targetId, "firefox:firefox-tab");

  const page = await adapter.getPageState("chromium:chromium-session");
  assert.equal(page.sessionId, "chromium:chromium-session");
  assert.equal(page.targetId, "chromium:chromium-tab");

  const waitResult = await adapter.waitFor("firefox:firefox-session", {
    selector: "#app",
  });
  assert.equal(waitResult.sessionId, "firefox:firefox-session");
  assert.equal(waitResult.condition.selector, "#app");

  const cookies = await adapter.getCookies("chromium:chromium-session");
  assert.equal(cookies.sessionId, "chromium:chromium-session");
  assert.equal(cookies.browserFamily, "chromium");

  const storage = await adapter.getStorage("firefox:firefox-session");
  assert.equal(storage.sessionId, "firefox:firefox-session");
  assert.equal(storage.browserFamily, "firefox");

  const report = await adapter.captureDebugReport("chromium:chromium-session", {
    includeScreenshot: false,
  });
  assert.equal(report.sessionId, "chromium:chromium-session");
  assert.equal(report.options.includeScreenshot, false);

  const snapshot = await adapter.captureSessionSnapshot(
    "chromium:chromium-session",
  );
  assert.equal(snapshot.sessionId, "chromium:chromium-session");

  const restored = await adapter.restoreSessionSnapshot(
    "firefox:firefox-session",
    { page: { url: "https://example.com" } },
    { clearStorage: true },
  );
  assert.equal(restored.sessionId, "firefox:firefox-session");
  assert.equal(restored.options.clearStorage, true);

  const har = await adapter.getHar("firefox:firefox-session", {
    limit: 10,
  });
  assert.equal(har.sessionId, "firefox:firefox-session");
  assert.equal(har.options.limit, 10);

  const created = await adapter.createTab("https://example.com/new", {
    browserFamily: "firefox",
  });
  assert.equal(created.browserFamily, "firefox");
  assert.equal(created.targetId, "firefox:firefox-new-tab");

  const closed = await adapter.closeTarget("chromium:chromium-tab");
  assert.equal(closed.browserFamily, "chromium");
  assert.equal(closed.targetId, "chromium:chromium-tab");
  assert.deepEqual(closed.detachedSessions, [
    { sessionId: "chromium:chromium-session" },
  ]);
});
