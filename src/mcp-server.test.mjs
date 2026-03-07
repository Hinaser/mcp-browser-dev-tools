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
      return [{ targetId: "tab-1", title: "Example", url: "https://example.com" }];
    },
    listSessions() {
      return [{ sessionId: "session-1", targetId: "tab-1" }];
    },
    async attachToTarget(targetId) {
      return { sessionId: "session-2", targetId };
    },
    async detachSession(sessionId) {
      return { detached: true, sessionId };
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
      return [{ sessionId, limit, requestId: "req-1", url: "https://example.com" }];
    },
    async inspectElement(sessionId, selector) {
      return { sessionId, selector, found: true, node: { nodeName: "DIV" } };
    },
    async takeScreenshot(sessionId, format) {
      return { sessionId, format, data: "ZmFrZQ==" };
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

  assert.deepEqual(
    screenshotTool.inputSchema.properties.format.enum,
    ["png", "jpeg"],
  );
});
