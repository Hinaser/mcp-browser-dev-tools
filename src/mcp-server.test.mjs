import test from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(toolNames.includes("evaluate_js"), false);
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
      available: statusCalls >= 2,
      browserFamily: "auto",
      browsers:
        statusCalls >= 2
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

test("evaluate_js is only exposed when explicitly enabled", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_ENABLE_EVAL: "1" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/list",
  });

  const toolNames = response.result.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("evaluate_js"), true);
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

  assert.deepEqual(launchBrowserTool.inputSchema.properties.unsafeArgs, {
    type: "array",
    items: {
      type: "string",
    },
  });
  assert.deepEqual(ensureBrowserTool.inputSchema.properties.unsafeArgs, {
    type: "array",
    items: {
      type: "string",
    },
  });
});
