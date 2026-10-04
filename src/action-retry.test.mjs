import test from "node:test";

import assert from "node:assert/strict";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import {
  callTool,
  createFakeManager,
  createFlakyClickManager,
  notActionable,
} from "./mcp-test-support.mjs";

test("actions retry while the element is missing or not actionable", async () => {
  const { manager, calls } = createFlakyClickManager([
    { found: false },
    notActionable('Element "#save" is covered by <div#banner>'),
    { found: true, clicked: true },
  ]);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const result = (
    await callTool(server, "click", {
      sessionId: "session-1",
      selector: "#save",
    })
  ).result.structuredContent;

  assert.equal(calls.length, 3);
  assert.equal(result.clicked, true);
  assert.equal(result.waitedMs >= 200, true);
});

test("actions fail with the last reason once timeoutMs passes", async () => {
  const covered = createFlakyClickManager([
    notActionable('Element "#save" is covered by <div#banner>'),
  ]);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: covered.manager,
  });
  const startedAt = Date.now();
  const response = await callTool(server, "click", {
    sessionId: "session-1",
    selector: "#save",
    timeoutMs: 250,
  });
  assert.match(response.error.message, /is covered by <div#banner>/);
  assert.equal(Date.now() - startedAt >= 250, true);
  assert.equal(covered.calls.length >= 2, true);

  const missing = createFlakyClickManager([{ found: false }]);
  const missingServer = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: missing.manager,
  });
  const missingResult = (
    await callTool(missingServer, "click", {
      sessionId: "session-1",
      selector: "#save",
      timeoutMs: 0,
    })
  ).result.structuredContent;
  assert.equal(missingResult.found, false);
  assert.equal(missing.calls.length, 1);
});

test("actions do not retry invalid selectors or other errors", async () => {
  for (const outcome of [
    { found: false, error: "'#[' is not a valid selector" },
    new Error("Session closed"),
  ]) {
    const { manager, calls } = createFlakyClickManager([outcome]);
    const server = new McpBrowserDevToolsServer({
      config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
      browserAdapter: manager,
    });
    await callTool(server, "click", { sessionId: "session-1", selector: "#[" });
    assert.equal(calls.length, 1);
  }
});

test("press_key without a selector is sent once", async () => {
  const manager = createFakeManager();
  let presses = 0;
  manager.pressKey = async () => {
    presses += 1;
    throw notActionable("not reached in practice");
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  await callTool(server, "press_key", { sessionId: "session-1", key: "Enter" });
  assert.equal(presses, 1);
});

test("actions report waitedMs only after retrying, including when they give up", async () => {
  const slow = createFlakyClickManager([{ found: true, clicked: true }]);
  const inner = slow.manager.click;
  slow.manager.click = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return inner(...args);
  };
  const slowServer = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: slow.manager,
  });
  const slowResult = (
    await callTool(slowServer, "click", {
      sessionId: "session-1",
      selector: "#save",
    })
  ).result.structuredContent;
  assert.equal("waitedMs" in slowResult, false);

  const missing = createFlakyClickManager([{ found: false }]);
  const missingServer = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: missing.manager,
  });
  const gaveUp = (
    await callTool(missingServer, "click", {
      sessionId: "session-1",
      selector: "#save",
      timeoutMs: 150,
    })
  ).result.structuredContent;
  assert.equal(gaveUp.found, false);
  assert.equal(gaveUp.waitedMs >= 150, true);

  const covered = createFlakyClickManager([
    notActionable('Element "#save" is covered by <div#banner>'),
  ]);
  const coveredServer = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: covered.manager,
  });
  const response = await callTool(coveredServer, "click", {
    sessionId: "session-1",
    selector: "#save",
    timeoutMs: 150,
  });
  assert.match(response.error.message, /still failing after \d+ms/);
});
