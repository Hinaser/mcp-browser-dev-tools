import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { PACKAGE_VERSION } from "./package-info.mjs";

function createFakeManager() {
  return {
    async getBrowserStatus() {
      return { available: true };
    },
    async listTargets() {
      return [
        { targetId: "tab-1", title: "Example", url: "https://example.com" },
      ];
    },
    listSessions() {
      return [{ sessionId: "session-1", targetId: "tab-1" }];
    },
    async createTab(url = "about:blank", options = {}) {
      return {
        targetId: "tab-2",
        url,
        browserFamily: options.browserFamily ?? "chromium",
      };
    },
    async closeTarget(targetId) {
      return {
        targetId,
        closed: true,
        detachedSessions: [{ sessionId: "session-1" }],
      };
    },
    async attachToTarget(targetId) {
      return { sessionId: "session-2", targetId };
    },
    async detachSession(sessionId) {
      return { detached: true, sessionId };
    },
    async getPageState(sessionId) {
      return {
        sessionId,
        url: "https://example.com/dashboard",
        viewport: { width: 1280, height: 720 },
        readyState: "complete",
      };
    },
    async waitFor(sessionId, options) {
      return {
        sessionId,
        matched: true,
        condition: options,
      };
    },
    async navigate(sessionId, url, options) {
      return { sessionId, url, waitUntil: options.waitUntil ?? "complete" };
    },
    async reload(sessionId, options) {
      return {
        sessionId,
        url: "https://example.com/dashboard",
        ignoreCache: options.ignoreCache ?? false,
      };
    },
    async getCookies(sessionId) {
      return {
        sessionId,
        cookies: {
          totalEntries: 1,
          returnedEntries: 1,
          truncated: false,
          entries: [{ name: "sid", value: "abc123" }],
          source: "document.cookie",
        },
      };
    },
    async getStorage(sessionId) {
      return {
        sessionId,
        storage: {
          localStorage: {
            type: "localStorage",
            totalEntries: 1,
            returnedEntries: 1,
            truncated: false,
            entries: [{ key: "theme", value: "light" }],
          },
          sessionStorage: {
            type: "sessionStorage",
            totalEntries: 0,
            returnedEntries: 0,
            truncated: false,
            entries: [],
          },
        },
      };
    },
    async captureDebugReport(sessionId, options) {
      return {
        sessionId,
        capturedAt: "2026-03-11T00:00:00.000Z",
        page: {
          url: "https://example.com/dashboard",
          title: "Dashboard",
        },
        cookies: {
          totalEntries: 1,
          sampleNames: ["sid"],
        },
        storage: {
          localStorage: {
            totalEntries: 1,
            sampleKeys: ["theme"],
          },
        },
        console: [{ kind: "console", text: "hello" }],
        network: [{ requestId: "req-1", url: "https://example.com/api" }],
        screenshot:
          options.includeScreenshot === false ? null : { format: "png" },
      };
    },
    async captureSessionSnapshot(sessionId) {
      return {
        sessionId,
        capturedAt: "2026-03-11T00:00:00.000Z",
        page: {
          url: "https://example.com/dashboard",
          title: "Dashboard",
        },
        cookies: {
          entries: [{ name: "sid", value: "abc123" }],
        },
        storage: {
          localStorage: {
            entries: [{ key: "theme", value: "light" }],
          },
          sessionStorage: {
            entries: [],
          },
        },
      };
    },
    async restoreSessionSnapshot(sessionId, snapshot, options) {
      return {
        sessionId,
        restoredAt: "2026-03-11T00:00:00.000Z",
        snapshot,
        clearStorage: options.clearStorage ?? false,
      };
    },
    getHar(sessionId, options) {
      return {
        sessionId,
        limit: options.limit,
        log: {
          version: "1.2",
          entries: [],
        },
      };
    },
    async click(sessionId, selector) {
      return { sessionId, selector, clicked: true };
    },
    async hover(sessionId, selector) {
      return { sessionId, selector, hovered: true };
    },
    async type(sessionId, selector, text, options) {
      return {
        sessionId,
        selector,
        typedText: text,
        clear: options.clear ?? true,
      };
    },
    async select(sessionId, selector, options) {
      return {
        sessionId,
        selector,
        selectedValue: options.value ?? null,
        selectedLabel: options.label ?? null,
      };
    },
    async pressKey(sessionId, key, selector) {
      return { sessionId, key, selector: selector ?? null, dispatched: true };
    },
    async scroll(sessionId, options) {
      return { sessionId, ...options, scrolled: true };
    },
    async setViewport(sessionId, options) {
      return { sessionId, applied: true, viewport: options };
    },
    async evaluate(sessionId, expression) {
      return { sessionId, result: expression };
    },
    async getDocument(sessionId, depth) {
      return { sessionId, depth, root: { nodeName: "HTML" } };
    },
    getConsoleMessages(sessionId, limit) {
      return [{ sessionId, limit, kind: "console", text: "hello" }];
    },
    getNetworkRequests(sessionId, limit) {
      return [
        { sessionId, limit, requestId: "req-1", url: "https://example.com" },
      ];
    },
    async inspectElement(sessionId, selector) {
      return { sessionId, selector, found: true, node: { nodeName: "DIV" } };
    },
    async takeScreenshot(sessionId, format, options) {
      return {
        sessionId,
        format,
        selector: options.selector ?? null,
        data: "ZmFrZQ==",
      };
    },
    getEvents(sessionId, limit) {
      return [{ sessionId, limit, method: "Runtime.consoleAPICalled" }];
    },
  };
}

test("initialize returns MCP server metadata", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
    },
  });

  assert.equal(response.result.serverInfo.name, "mcp-browser-dev-tools");
  assert.equal(response.result.serverInfo.version, PACKAGE_VERSION);
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.match(response.result.instructions, /prefer run_steps/);
});

test("start resumes the input stream so spawned stdio servers stay alive", () => {
  let resumed = false;
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
    input: {
      on() {},
      resume() {
        resumed = true;
      },
    },
    output: {
      write() {
        return true;
      },
    },
    errorOutput: {
      write() {
        return true;
      },
    },
  });

  server.start();

  assert.equal(resumed, true);
});

test("tools/list exposes the broker tools", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });

  const toolNames = response.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("list_tabs"));
  assert.ok(toolNames.includes("launch_browser"));
  assert.ok(toolNames.includes("ensure_browser"));
  assert.ok(toolNames.includes("new_tab"));
  assert.ok(toolNames.includes("close_tab"));
  assert.ok(toolNames.includes("get_page_state"));
  assert.ok(toolNames.includes("compare_page_state"));
  assert.ok(toolNames.includes("compare_selector"));
  assert.ok(toolNames.includes("get_cookies"));
  assert.ok(toolNames.includes("get_storage"));
  assert.ok(toolNames.includes("capture_debug_report"));
  assert.ok(toolNames.includes("capture_session_snapshot"));
  assert.ok(toolNames.includes("restore_session_snapshot"));
  assert.ok(toolNames.includes("get_har"));
  assert.ok(toolNames.includes("wait_for"));
  assert.ok(toolNames.includes("navigate"));
  assert.ok(toolNames.includes("click"));
  assert.ok(toolNames.includes("type"));
  assert.ok(toolNames.includes("set_viewport"));
  assert.ok(toolNames.includes("get_console_messages"));
  assert.ok(toolNames.includes("get_network_requests"));
  assert.ok(toolNames.includes("inspect_element"));
  assert.ok(toolNames.includes("get_events"));
  assert.ok(toolNames.includes("evaluate_js"));
});

test("tools/call executes a tool and returns structured content", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "attach_tab",
      arguments: {
        targetId: "tab-1",
      },
    },
  });

  assert.equal(response.result.structuredContent.sessionId, "session-2");
  assert.match(response.result.content[0].text, /session-2/);
});

test("browser_status includes broker version metadata", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 36,
    method: "tools/call",
    params: {
      name: "browser_status",
      arguments: {},
    },
  });

  assert.equal(
    response.result.structuredContent.serverName,
    "mcp-browser-dev-tools",
  );
  assert.equal(
    response.result.structuredContent.serverVersion,
    PACKAGE_VERSION,
  );
  assert.equal(response.result.structuredContent.available, true);
});

test("launch_browser delegates to the launch service", async () => {
  let capturedArgs = null;
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      capturedArgs = args;
      return {
        browserFamily: "chromium",
        url: args.url ?? "about:blank",
        executable: "/usr/bin/chromium",
        args: ["--remote-debugging-port=9222", "about:blank"],
        pid: 1234,
        endpoint: "http://127.0.0.1:9222",
        doctorReport: {
          browserStatus: {
            available: true,
          },
        },
      };
    },
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 53,
    method: "tools/call",
    params: {
      name: "launch_browser",
      arguments: {
        browserFamily: "chromium",
        url: "https://example.com/app",
        waitMs: 2000,
      },
    },
  });

  assert.equal(capturedArgs.url, "https://example.com/app");
  assert.equal(capturedArgs.browserFamily, "chromium");
  assert.equal(capturedArgs.waitMs, 2000);
  assert.equal(response.result.structuredContent.pid, 1234);
  assert.equal(
    response.result.structuredContent.endpoint,
    "http://127.0.0.1:9222",
  );
});

test("launch_browser passes unsafeArgs through when enabled", async () => {
  let capturedArgs = null;
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
    }),
    browserAdapter: createFakeManager(),
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      capturedArgs = args;
      return {
        browserFamily: "chromium",
        url: "about:blank",
        executable: "/usr/bin/chromium",
        args: ["--remote-debugging-port=9222", "about:blank"],
        pid: 1234,
        endpoint: "http://127.0.0.1:9222",
        unsafeArgs: args.unsafeArgs ?? [],
        doctorReport: {
          browserStatus: {
            available: true,
          },
        },
      };
    },
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 153,
    method: "tools/call",
    params: {
      name: "launch_browser",
      arguments: {
        browserFamily: "chromium",
        unsafeArgs: ["--remote-allow-origins=http://localhost:9222"],
      },
    },
  });

  assert.deepEqual(capturedArgs.unsafeArgs, [
    "--remote-allow-origins=http://localhost:9222",
  ]);
  assert.deepEqual(response.result.structuredContent.unsafeArgs, [
    "--remote-allow-origins=http://localhost:9222",
  ]);
});

test("ensure_browser opens a tab when a compatible browser is already available", async () => {
  let capturedCreateTab = null;
  const browserAdapter = createFakeManager();
  browserAdapter.getBrowserStatus = async () => ({
    available: true,
    browserFamily: "auto",
    browsers: {
      chromium: { available: true },
      firefox: { available: false },
    },
  });
  browserAdapter.createTab = async (url, options = {}) => {
    capturedCreateTab = { url, options };
    return {
      targetId: "tab-3",
      url,
      browserFamily: options.browserFamily ?? "chromium",
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter,
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 55,
    method: "tools/call",
    params: {
      name: "ensure_browser",
      arguments: {
        browserFamily: "chromium",
        url: "https://example.com/dashboard",
      },
    },
  });

  assert.equal(response.result.structuredContent.available, true);
  assert.equal(response.result.structuredContent.launched, false);
  assert.equal(response.result.structuredContent.tab.targetId, "tab-3");
  assert.deepEqual(capturedCreateTab, {
    url: "https://example.com/dashboard",
    options: {
      browserFamily: "chromium",
    },
  });
});

test("ensure_browser launches a browser when none is reachable", async () => {
  let launchCalls = 0;
  let statusCalls = 0;
  const browserAdapter = createFakeManager();
  browserAdapter.getBrowserStatus = async () => {
    statusCalls += 1;
    return {
      available: launchCalls > 0,
      browserFamily: "auto",
      browsers:
        launchCalls > 0
          ? {
              chromium: { available: true },
              firefox: { available: false },
            }
          : {
              chromium: { available: false },
              firefox: { available: false },
            },
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter,
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      launchCalls += 1;
      return {
        browserFamily: args.browserFamily ?? "chromium",
        endpoint: "http://127.0.0.1:9222",
        doctorReport: {
          browserStatus: {
            available: true,
          },
        },
      };
    },
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 56,
    method: "tools/call",
    params: {
      name: "ensure_browser",
      arguments: {
        browserFamily: "chromium",
        launchIfMissing: true,
        createTab: false,
      },
    },
  });

  assert.equal(launchCalls, 1);
  assert.equal(statusCalls, 4, "three probes before launching, one after");
  assert.equal(response.result.structuredContent.available, true);
  assert.equal(response.result.structuredContent.launched, true);
  assert.equal(
    response.result.structuredContent.launch.endpoint,
    "http://127.0.0.1:9222",
  );
  assert.equal(response.result.structuredContent.tab, null);
});

test("new_tab delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 37,
    method: "tools/call",
    params: {
      name: "new_tab",
      arguments: {
        browserFamily: "chromium",
        url: "https://example.com/new",
      },
    },
  });

  assert.equal(response.result.structuredContent.targetId, "tab-2");
  assert.equal(
    response.result.structuredContent.url,
    "https://example.com/new",
  );
});

test("close_tab delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 38,
    method: "tools/call",
    params: {
      name: "close_tab",
      arguments: {
        targetId: "tab-1",
      },
    },
  });

  assert.equal(response.result.structuredContent.closed, true);
  assert.deepEqual(response.result.structuredContent.detachedSessions, [
    { sessionId: "session-1" },
  ]);
});

test("wait_for delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: {
      name: "wait_for",
      arguments: {
        sessionId: "session-1",
        selector: "#app",
        state: "visible",
        timeoutMs: 1000,
      },
    },
  });

  assert.equal(response.result.structuredContent.matched, true);
  assert.equal(response.result.structuredContent.condition.selector, "#app");
  assert.equal(response.result.structuredContent.condition.state, "visible");
});

test("inspect_element delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: {
      name: "inspect_element",
      arguments: {
        sessionId: "session-1",
        selector: "#app",
      },
    },
  });

  assert.equal(response.result.structuredContent.selector, "#app");
  assert.equal(response.result.structuredContent.found, true);
});

test("navigate delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 34,
    method: "tools/call",
    params: {
      name: "navigate",
      arguments: {
        sessionId: "session-1",
        url: "https://example.com/settings",
        waitUntil: "interactive",
      },
    },
  });

  assert.equal(
    response.result.structuredContent.url,
    "https://example.com/settings",
  );
  assert.equal(response.result.structuredContent.waitUntil, "interactive");
});

test("take_screenshot forwards the optional selector", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 35,
    method: "tools/call",
    params: {
      name: "take_screenshot",
      arguments: {
        sessionId: "session-1",
        selector: "text=Open modal",
      },
    },
  });

  assert.equal(response.result.structuredContent.selector, "text=Open modal");
});

test("evaluate_js is exposed by default and hidden when disabled", async () => {
  for (const [env, exposed] of [
    [{}, true],
    [{ MCP_BROWSER_ENABLE_EVAL: "0" }, false],
  ]) {
    const server = new McpBrowserDevToolsServer({
      config: loadConfig(env),
      browserAdapter: createFakeManager(),
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/list",
    });

    const toolNames = response.result.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("evaluate_js"), exposed);
  }
});

test("initialize returns the server protocol version, not the client hint", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 32,
    method: "initialize",
    params: {
      protocolVersion: "9999-99-99",
    },
  });

  assert.equal(response.result.protocolVersion, "2024-11-05");
});

test("unknown tool calls return an error response", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "missing_tool",
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /Unknown tool/);
});

test("tool calls validate arguments against the declared schema", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "get_events",
      arguments: {
        sessionId: "session-1",
        limit: "50",
      },
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /arguments\.limit must be an integer/);
});

test("get_storage filters the requested storage area", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: {
      name: "get_storage",
      arguments: {
        sessionId: "session-1",
        area: "localStorage",
      },
    },
  });

  assert.deepEqual(response.result.structuredContent.storage, {
    localStorage: {
      type: "localStorage",
      totalEntries: 1,
      returnedEntries: 1,
      truncated: false,
      entries: [{ key: "theme", value: "light" }],
    },
  });
});

test("compare_page_state compares bounded page fields across sessions", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 45,
    method: "tools/call",
    params: {
      name: "compare_page_state",
      arguments: {
        sessionIdA: "session-1",
        sessionIdB: "session-2",
      },
    },
  });

  assert.equal(response.result.structuredContent.matches, true);
  assert.equal(response.result.structuredContent.fields.url.equal, true);
});

test("compare_selector compares bounded element fields across sessions", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 46,
    method: "tools/call",
    params: {
      name: "compare_selector",
      arguments: {
        sessionIdA: "session-1",
        sessionIdB: "session-2",
        selector: "#app",
      },
    },
  });

  assert.equal(response.result.structuredContent.selector, "#app");
  assert.equal(response.result.structuredContent.matches, true);
  assert.equal(response.result.structuredContent.fields.found.equal, true);
});

test("restore_session_snapshot parses snapshot JSON before delegating", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 47,
    method: "tools/call",
    params: {
      name: "restore_session_snapshot",
      arguments: {
        sessionId: "session-1",
        snapshot: JSON.stringify({
          page: { url: "https://example.com/dashboard" },
          storage: {
            localStorage: {
              entries: [{ key: "theme", value: "dark" }],
            },
          },
        }),
        clearStorage: true,
      },
    },
  });

  assert.equal(response.result.structuredContent.clearStorage, true);
  assert.equal(
    response.result.structuredContent.snapshot.storage.localStorage.entries[0]
      .value,
    "dark",
  );
});

test("select requires either value or label", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 51,
    method: "tools/call",
    params: {
      name: "select",
      arguments: {
        sessionId: "session-1",
        selector: "#plan",
      },
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /requires either value or label/);
});

test("wait_for requires at least one condition", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 52,
    method: "tools/call",
    params: {
      name: "wait_for",
      arguments: {
        sessionId: "session-1",
      },
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /requires at least one/);
});

test("Firefox tool schemas only advertise screenshot formats the adapter supports", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_FAMILY: "firefox" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
  });

  const screenshotTool = response.result.tools.find(
    (tool) => tool.name === "take_screenshot",
  );

  assert.deepEqual(screenshotTool.inputSchema.properties.format.enum, [
    "png",
    "jpeg",
  ]);
});

test("auto mode requires browserFamily when creating a new tab", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_FAMILY: "auto" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 39,
    method: "tools/list",
  });

  const newTabTool = response.result.tools.find(
    (tool) => tool.name === "new_tab",
  );

  assert.deepEqual(newTabTool.inputSchema.properties.browserFamily.enum, [
    "chromium",
    "firefox",
  ]);
  assert.deepEqual(newTabTool.inputSchema.required, ["browserFamily"]);
});

test("auto mode requires browserFamily when launching a browser", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_FAMILY: "auto" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 54,
    method: "tools/list",
  });

  const launchBrowserTool = response.result.tools.find(
    (tool) => tool.name === "launch_browser",
  );

  assert.deepEqual(
    launchBrowserTool.inputSchema.properties.browserFamily.enum,
    ["chromium", "edge", "firefox"],
  );
  assert.deepEqual(launchBrowserTool.inputSchema.required, ["browserFamily"]);
  assert.equal(
    Object.hasOwn(launchBrowserTool.inputSchema.properties, "unsafeArgs"),
    false,
  );
});

test("auto mode requires browserFamily when ensuring a browser", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_FAMILY: "auto" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 57,
    method: "tools/list",
  });

  const ensureBrowserTool = response.result.tools.find(
    (tool) => tool.name === "ensure_browser",
  );

  assert.deepEqual(
    ensureBrowserTool.inputSchema.properties.browserFamily.enum,
    ["chromium", "edge", "firefox"],
  );
  assert.deepEqual(ensureBrowserTool.inputSchema.required, ["browserFamily"]);
  assert.equal(
    Object.hasOwn(ensureBrowserTool.inputSchema.properties, "unsafeArgs"),
    false,
  );
});

test("unsafe launch args are only exposed when explicitly enabled", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
    }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 58,
    method: "tools/list",
  });

  const launchBrowserTool = response.result.tools.find(
    (tool) => tool.name === "launch_browser",
  );
  const ensureBrowserTool = response.result.tools.find(
    (tool) => tool.name === "ensure_browser",
  );

  for (const tool of [launchBrowserTool, ensureBrowserTool]) {
    const { description, ...shape } = tool.inputSchema.properties.unsafeArgs;
    assert.deepEqual(shape, {
      type: "array",
      items: {
        type: "string",
      },
    });
    assert.match(description, /command-line flags/);
  }
});

function createLaunchServer({ chromiumAvailable, launches }) {
  const browserAdapter = createFakeManager();
  browserAdapter.getBrowserStatus = async () => {
    const available = chromiumAvailable();
    return {
      available,
      browserFamily: "auto",
      browsers: {
        chromium: { available },
        firefox: { available: false },
      },
    };
  };

  return new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter,
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      launches.push(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { browserFamily: args.browserFamily, launched: true };
    },
  });
}

function callTool(server, name, args, id = 1) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

test("launch_browser reuses a reachable browser instead of launching another", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  const response = await callTool(server, "launch_browser", {
    browserFamily: "chromium",
  });

  assert.equal(launches.length, 0);
  assert.equal(response.result.structuredContent.reused, true);
  assert.equal(response.result.structuredContent.launched, false);
});

test("launch_browser launches on an explicit port even when a browser is reachable", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  await callTool(server, "launch_browser", {
    browserFamily: "chromium",
    port: 9333,
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].port, 9333);
});

test("parallel ensure_browser calls launch only one browser", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => launches.length > 0,
    launches,
  });

  const responses = await Promise.all(
    [1, 2, 3].map((id) =>
      callTool(
        server,
        "ensure_browser",
        { browserFamily: "chromium", createTab: false },
        id,
      ),
    ),
  );

  assert.equal(launches.length, 1);
  assert.deepEqual(
    responses.map((response) => response.result.structuredContent.launched),
    [true, false, false],
  );
});

test("ensure_browser does not launch when the browser misses one status check", async () => {
  const launches = [];
  let checks = 0;
  const server = createLaunchServer({
    chromiumAvailable: () => {
      checks += 1;
      return checks > 1;
    },
    launches,
  });

  const response = await callTool(server, "ensure_browser", {
    browserFamily: "chromium",
    createTab: false,
  });

  assert.equal(launches.length, 0);
  assert.equal(response.result.structuredContent.available, true);
});

test("ensure_browser treats Edge as available through the Chromium adapter in auto mode", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  const response = await callTool(server, "ensure_browser", {
    browserFamily: "edge",
    createTab: false,
  });

  assert.equal(launches.length, 0);
  assert.equal(response.result.structuredContent.available, true);
});

test("ensure_browser does not launch again while a launched browser is still starting", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => false,
    launches,
  });

  const [first, second] = await Promise.all([
    callTool(
      server,
      "ensure_browser",
      { browserFamily: "chromium", createTab: false },
      1,
    ),
    callTool(
      server,
      "ensure_browser",
      { browserFamily: "chromium", createTab: false },
      2,
    ),
  ]);

  assert.equal(launches.length, 1);
  assert.equal(first.result.structuredContent.launched, true);
  assert.match(
    second.error.message,
    /has not exposed its debugging endpoint yet/,
  );
});

test("launch_browser with an explicit profile does not reuse the running browser", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  await callTool(server, "launch_browser", {
    browserFamily: "chromium",
    userDataDir: "/profiles/other",
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].userDataDir, "/profiles/other");
});

test("launch_browser opens the requested url when reusing a running browser", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });
  const tabs = [];
  server.browserAdapter.createTab = async (url, options) => {
    tabs.push([url, options.browserFamily]);
    return { targetId: "tab-9", url };
  };

  const response = await callTool(server, "launch_browser", {
    browserFamily: "chromium",
    url: "https://example.com/app",
  });

  assert.deepEqual(tabs, [["https://example.com/app", "chromium"]]);
  assert.equal(response.result.structuredContent.tab.targetId, "tab-9");
});

test("a confirmed launch does not block the next explicit launch", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => false,
    launches,
  });
  server.launchBrowser = async (args) => {
    launches.push(args);
    return {
      browserFamily: args.browserFamily,
      launched: true,
      doctorReport: { browserStatus: { available: true } },
    };
  };

  await callTool(server, "launch_browser", { browserFamily: "chromium" }, 1);
  const second = await callTool(
    server,
    "launch_browser",
    { browserFamily: "chromium", port: 9333 },
    2,
  );

  assert.equal(second.error, undefined);
  assert.equal(launches.length, 2);
});

function callRunSteps(server, args) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id: 90,
    method: "tools/call",
    params: {
      name: "run_steps",
      arguments: args,
    },
  });
}

test("run_steps runs steps in order and returns screenshots as images", async () => {
  const manager = createFakeManager();
  const calls = [];
  const originalClick = manager.click;
  manager.click = async (...args) => {
    calls.push("click");
    return originalClick.apply(manager, args);
  };
  manager.takeScreenshot = async (sessionId, format) => {
    calls.push("take_screenshot");
    return {
      sessionId,
      format,
      mimeType: "image/png",
      encoding: "base64",
      data: "ZmFrZQ==",
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "text=Save" } },
      { tool: "sleep", arguments: { ms: 1 } },
      { tool: "take_screenshot" },
    ],
  });

  const value = response.result.structuredContent;
  assert.deepEqual(calls, ["click", "take_screenshot"]);
  assert.equal(value.ok, true);
  assert.equal(value.ranSteps, 3);
  assert.equal(value.steps[0].result.selector, "text=Save");
  assert.deepEqual(value.steps[1].result, { sleptMs: 1 });
  assert.equal(value.steps[2].result.image, 1);
  assert.equal(value.steps[2].result.data, undefined);
  assert.deepEqual(response.result.content[1], {
    type: "image",
    data: "ZmFrZQ==",
    mimeType: "image/png",
  });
  assert.doesNotMatch(response.result.content[0].text, /ZmFrZQ==/);
});

test("run_steps stops at the first failing step unless continueOnError", async () => {
  const manager = createFakeManager();
  manager.click = async () => {
    throw new Error("element is covered");
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const steps = [
    { tool: "click", arguments: { selector: "#save" } },
    { tool: "get_page_state" },
  ];

  const stopped = (
    await callRunSteps(server, { sessionId: "session-1", steps })
  ).result.structuredContent;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.ranSteps, 1);
  assert.equal(stopped.skippedSteps, 1);
  assert.equal(stopped.steps[0].error, "element is covered");

  const continued = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps,
      continueOnError: true,
    })
  ).result.structuredContent;
  assert.equal(continued.ok, false);
  assert.equal(continued.ranSteps, 2);
  assert.equal(continued.steps[1].ok, true);
});

test("run_steps validates every step before running any", async () => {
  const manager = createFakeManager();
  let clicked = false;
  manager.click = async () => {
    clicked = true;
    return {};
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const badArgs = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "#save" } },
      { tool: "wait_for", arguments: { timeoutMs: "1000" } },
    ],
  });
  assert.match(
    badArgs.error.message,
    /arguments\.steps\[1\]\.arguments\.timeoutMs must be an integer/,
  );

  const sessionOverride = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [{ tool: "click", arguments: { sessionId: "x", selector: "#a" } }],
  });
  assert.match(sessionOverride.error.message, /sessionId is not allowed/);

  const longSleep = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [{ tool: "sleep", arguments: { ms: 60_000 } }],
  });
  assert.match(longSleep.error.message, /ms must be <= 30000/);

  const missingCondition = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "#save" } },
      { tool: "wait_for" },
    ],
  });
  assert.match(missingCondition.error.message, /wait_for requires at least/);

  const notSessionTool = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [{ tool: "launch_browser" }],
  });
  assert.match(notSessionTool.error.message, /tool must be one of/);

  const unknownKey = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "#save" } },
      { tool: "press_key", arguments: { key: "Hyper+Enter" } },
    ],
  });
  assert.match(unknownKey.error.message, /Unsupported modifier "Hyper"/);

  assert.equal(clicked, false);
});

test("take_screenshot with path writes the decoded image and returns its path", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshot-as-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = createFakeManager();
  let requestedFormat;
  manager.takeScreenshot = async (sessionId, format) => {
    requestedFormat = format;
    return {
      format,
      mimeType: "image/jpeg",
      encoding: "base64",
      data: Buffer.from("raw-image").toString("base64"),
      scope: "page",
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const filePath = path.join(dir, "nested", "shot.JPG");

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: filePath,
  });

  const value = response.result.structuredContent;
  assert.equal(requestedFormat, "jpeg");
  assert.equal(value.path, filePath);
  assert.equal(value.data, undefined);
  assert.equal(value.scope, "page");
  assert.equal(await readFile(filePath, "utf8"), "raw-image");

  const again = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: filePath,
  });
  assert.match(again.error.message, /already exists/);

  const replaced = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: filePath,
    overwrite: true,
  });
  assert.equal(replaced.result.structuredContent.path, filePath);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("take_screenshot replaces a symlink instead of writing through it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshot-as-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, ".bashrc");
  const link = path.join(dir, "shot.png");
  await writeFile(config, "keep");
  await symlink(config, link);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const refused = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: link,
  });
  assert.match(refused.error.message, /already exists/);

  await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: link,
    overwrite: true,
  });
  assert.equal(await readFile(config, "utf8"), "keep");
  assert.equal(await readFile(link, "utf8"), "fake");
});

test("take_screenshot fails when the selector matches nothing", async () => {
  const manager = createFakeManager();
  manager.takeScreenshot = async (sessionId, format, options) => ({
    format,
    scope: "element",
    selector: options.selector,
    found: false,
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "take_screenshot", arguments: { selector: "#missing" } },
      { tool: "get_page_state" },
    ],
  });

  const value = response.result.structuredContent;
  assert.equal(value.ok, false);
  assert.equal(value.skippedSteps, 1);
  assert.match(value.steps[0].error, /No element matches selector #missing/);
});

test("take_screenshot output file defaults to a temp file", async (t) => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    output: "file",
    format: "webp",
  });

  const filePath = response.result.structuredContent.path;
  t.after(() => rm(path.dirname(filePath), { recursive: true, force: true }));
  assert.ok(filePath.startsWith(tmpdir()));
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.match(filePath, /\.webp$/);
  assert.equal(await readFile(filePath, "utf8"), "fake");
});

test("take_screenshot rejects unsafe or mismatched paths before capturing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshot-as-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = createFakeManager();
  let captured = false;
  manager.takeScreenshot = async () => {
    captured = true;
    return {};
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const config = path.join(dir, ".bashrc");
  await writeFile(config, "keep");

  const cases = [
    [{ path: "shot.png" }, /must be absolute/],
    [{ path: config }, /must end with \.png/],
    [{ path: path.join(dir, "a.png"), format: "jpeg" }, /does not match/],
    [{ path: path.join(dir, "b.png"), output: "image" }, /require output file/],
    [{ overwrite: true }, /require output file/],
  ];
  for (const [args, pattern] of cases) {
    const response = await callTool(server, "take_screenshot", {
      sessionId: "session-1",
      ...args,
    });
    assert.match(response.error.message, pattern);
  }

  const firefox = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_FAMILY: "firefox" }),
    browserAdapter: manager,
  });
  const webp = await callTool(firefox, "take_screenshot", {
    sessionId: "session-1",
    path: path.join(dir, "a.webp"),
  });
  assert.match(webp.error.message, /must end with \.png, \.jpg, \.jpeg$/);

  assert.equal(captured, false);
  assert.equal(await readFile(config, "utf8"), "keep");
});

test("run_steps treats a missing element as a failed step, except for inspect_element", async () => {
  const manager = createFakeManager();
  const clicked = [];
  manager.click = async (sessionId, selector) => {
    clicked.push(selector);
    return { selector, found: selector !== "#missing" };
  };
  manager.inspectElement = async (sessionId, selector) => ({
    selector,
    found: false,
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const missingClick = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        { tool: "click", arguments: { selector: "#missing" } },
        { tool: "click", arguments: { selector: "#submit" } },
      ],
    })
  ).result.structuredContent;
  assert.deepEqual(clicked, ["#missing"]);
  assert.equal(missingClick.ok, false);
  assert.equal(
    missingClick.steps[0].error,
    "No element matches selector #missing",
  );
  assert.equal(missingClick.steps[0].result.found, false);

  const absenceCheck = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [{ tool: "inspect_element", arguments: { selector: "#gone" } }],
    })
  ).result.structuredContent;
  assert.equal(absenceCheck.ok, true);
});

test("take_screenshot output image returns image content without base64 text", async () => {
  const manager = createFakeManager();
  manager.takeScreenshot = async (sessionId, format) => ({
    format,
    mimeType: "image/png",
    encoding: "base64",
    data: "ZmFrZQ==",
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    output: "image",
  });

  assert.equal(response.result.structuredContent.data, undefined);
  assert.equal(response.result.structuredContent.image, 1);
  assert.doesNotMatch(response.result.content[0].text, /ZmFrZQ==/);
  assert.deepEqual(response.result.content[1], {
    type: "image",
    data: "ZmFrZQ==",
    mimeType: "image/png",
  });
});

test("take_screenshot without new arguments still returns base64 data", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
  });

  assert.equal(response.result.structuredContent.data, "ZmFrZQ==");
  assert.equal(response.result.content.length, 1);
});

function createBranchingManager(elements) {
  const manager = createFakeManager();
  const calls = [];
  manager.inspectElement = async (sessionId, selector) =>
    elements[selector]
      ? {
          selector,
          found: true,
          node: { visible: true, ...elements[selector] },
        }
      : { selector, found: false };
  manager.click = async (sessionId, selector) => {
    calls.push(`click ${selector}`);
    return { selector, found: true };
  };
  return { manager, calls };
}

test("run_steps if runs the then branch when the condition holds", async () => {
  const { manager, calls } = createBranchingManager({
    "text=Accept cookies": { innerText: "Accept cookies" },
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "text=Accept cookies" },
            then: [
              { tool: "click", arguments: { selector: "text=Accept cookies" } },
            ],
            else: [{ tool: "click", arguments: { selector: "#other" } }],
          },
        },
        { tool: "click", arguments: { selector: "#next" } },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click text=Accept cookies", "click #next"]);
  assert.equal(value.ok, true);
  assert.equal(value.steps[0].result.matched, true);
  assert.equal(value.steps[0].result.branch, "then");
  assert.deepEqual(value.steps[0].result.checked, [
    { branch: "then", matched: true, observed: { found: true, visible: true } },
  ]);
  assert.equal(value.steps[0].result.steps[0].tool, "click");
});

test("run_steps if runs the first matching elseIf without nesting", async () => {
  const { manager, calls } = createBranchingManager({
    "#status": { innerText: "Payment failed: card declined" },
  });
  const inspected = [];
  const inspect = manager.inspectElement;
  manager.inspectElement = async (sessionId, selector) => {
    inspected.push(selector);
    return inspect(sessionId, selector);
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "#status", textEquals: "Paid" },
            then: [{ tool: "click", arguments: { selector: "#receipt" } }],
            elseIf: [
              {
                condition: { selector: "#status", textIncludes: "failed" },
                then: [{ tool: "click", arguments: { selector: "#retry" } }],
              },
              {
                condition: { selector: "#banner" },
                then: [{ tool: "click", arguments: { selector: "#banner" } }],
              },
            ],
            else: [{ tool: "click", arguments: { selector: "#fallback" } }],
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #retry"]);
  assert.deepEqual(inspected, ["#status", "#status"]);
  const result = value.steps[0].result;
  assert.equal(result.branch, "elseIf[0]");
  assert.equal(result.matched, true);
  assert.deepEqual(
    result.checked.map((check) => [check.branch, check.matched]),
    [
      ["then", false],
      ["elseIf[0]", true],
    ],
  );
  assert.equal(
    result.checked[1].observed.text,
    "Payment failed: card declined",
  );
});

test("run_steps if runs else when no condition holds", async () => {
  const { manager, calls } = createBranchingManager({});
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const result = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "#a" },
            elseIf: [{ condition: { selector: "#b" } }],
            else: [{ tool: "click", arguments: { selector: "#fallback" } }],
          },
        },
      ],
    })
  ).result.structuredContent.steps[0].result;

  assert.deepEqual(calls, ["click #fallback"]);
  assert.equal(result.matched, false);
  assert.equal(result.branch, "else");
  assert.equal(result.checked.length, 2);
});

test("run_steps if with no matching branch runs nothing and succeeds", async () => {
  const { manager, calls } = createBranchingManager({});
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { urlIncludes: "/login" },
            then: [{ tool: "click", arguments: { selector: "#login" } }],
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, []);
  assert.equal(value.ok, true);
  assert.equal(value.steps[0].result.branch, "else");
  assert.deepEqual(value.steps[0].result.steps, []);
  assert.equal(
    value.steps[0].result.checked[0].observed.url,
    "https://example.com/dashboard",
  );
});

test("run_steps stops the whole batch when a step inside a branch fails", async () => {
  const { manager, calls } = createBranchingManager({ "#open": {} });
  manager.click = async (sessionId, selector) => {
    calls.push(`click ${selector}`);
    return { selector, found: selector !== "#missing" };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "#open", state: "present" },
            then: [
              { tool: "click", arguments: { selector: "#missing" } },
              { tool: "click", arguments: { selector: "#inside" } },
            ],
          },
        },
        { tool: "click", arguments: { selector: "#after" } },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #missing"]);
  assert.equal(value.ok, false);
  assert.equal(value.steps[0].ok, false);
  assert.equal(value.skippedSteps, 1);
});

test("run_steps validates both if branches and limits before running", async () => {
  const { manager, calls } = createBranchingManager({});
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const run = (steps) =>
    callRunSteps(server, { sessionId: "session-1", steps });
  const click = { tool: "click", arguments: { selector: "#a" } };
  const nest = (depth) =>
    depth === 0
      ? click
      : {
          tool: "if",
          arguments: { condition: { url: "x" }, then: [nest(depth - 1)] },
        };

  const badElse = await run([
    click,
    {
      tool: "if",
      arguments: {
        condition: { selector: "#a" },
        then: [],
        else: [{ tool: "scroll" }],
      },
    },
  ]);
  assert.match(badElse.error.message, /scroll requires either selector/);

  const badCondition = await run([
    { tool: "if", arguments: { condition: { state: "visible" } } },
  ]);
  assert.match(
    badCondition.error.message,
    /arguments\.steps\[0\]\.arguments\.condition requires at least one/,
  );

  const badElseIf = await run([
    {
      tool: "if",
      arguments: {
        condition: { selector: "#a" },
        elseIf: [
          { condition: { selector: "#b" }, then: [click] },
          {
            condition: { url: "x" },
            then: [{ tool: "select", arguments: { selector: "#s" } }],
          },
        ],
      },
    },
  ]);
  assert.match(
    badElseIf.error.message,
    /select requires either value or label/,
  );

  const elseIfWithoutCondition = await run([
    {
      tool: "if",
      arguments: { condition: { selector: "#a" }, elseIf: [{ then: [] }] },
    },
  ]);
  assert.match(
    elseIfWithoutCondition.error.message,
    /elseIf\[0\]\.condition is required/,
  );

  const unknownField = await run([
    { tool: "if", arguments: { condition: { selector: "#a", timeoutMs: 5 } } },
  ]);
  assert.match(unknownField.error.message, /timeoutMs is not allowed/);

  const badKeyInElse = await run([
    click,
    {
      tool: "if",
      arguments: {
        condition: { selector: "#a" },
        then: [],
        else: [{ tool: "press_key", arguments: { key: "Enterr" } }],
      },
    },
  ]);
  assert.match(badKeyInElse.error.message, /Unsupported key "Enterr"/);

  assert.equal((await run([nest(4)])).result.structuredContent.ok, true);
  assert.match((await run([nest(5)])).error.message, /deeper than 4 levels/);

  const tooMany = await run([
    {
      tool: "if",
      arguments: {
        condition: { url: "x" },
        then: Array.from({ length: 50 }, () => click),
      },
    },
  ]);
  assert.match(tooMany.error.message, /at most 50 steps/);

  assert.equal(calls.length, 0);
});

test("wait_for passes text conditions to the adapter", async () => {
  const manager = createFakeManager();
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callTool(server, "wait_for", {
    sessionId: "session-1",
    selector: "#status",
    textIncludes: "Saved",
  });
  assert.equal(
    response.result.structuredContent.condition.textIncludes,
    "Saved",
  );

  const invalid = await callTool(server, "wait_for", {
    sessionId: "session-1",
    url: "https://example.com",
    textEquals: "Saved",
  });
  assert.match(invalid.error.message, /require selector/);
});

test("tool calls append timing entries when MCP_BROWSER_TIMING_LOG is set", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "timing-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, "timing.jsonl");
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TIMING_LOG: logFile }),
    browserAdapter: createFakeManager(),
  });

  await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    output: "image",
  });
  await callTool(server, "wait_for", { sessionId: "session-1" });
  await callTool(server, "run_steps", {
    sessionId: "session-1",
    steps: [{ tool: "inspect_element", arguments: { selector: "#a" } }],
  });

  const entries = (await readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].tool, "take_screenshot");
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].images, 1);
  assert.ok(entries[0].responseChars > 0);
  assert.equal(entries[1].tool, "wait_for");
  assert.equal(entries[1].ok, false);
  assert.equal(typeof entries[1].ms, "number");
  assert.equal(entries[2].steps, 1);
  assert.equal(entries[2].stepsOk, true);
});

test("the run_steps example in the server instructions is a valid call", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });
  const { instructions } = (
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })
  ).result;
  const example = JSON.parse(
    instructions.slice(
      instructions.indexOf("{"),
      instructions.lastIndexOf("}") + 1,
    ),
  );

  const response = await callRunSteps(server, {
    ...example,
    sessionId: "session-1",
  });

  assert.equal(response.error, undefined);
  assert.equal(
    response.result.structuredContent.ranSteps,
    example.steps.length,
  );
});
