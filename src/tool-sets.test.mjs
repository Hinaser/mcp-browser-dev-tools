import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { createFakeManager } from "./mcp-test-support.mjs";
import { TOOL_GROUPS } from "./tool-sets.mjs";

test("every tool is in exactly one group", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });
  const { tools } = (
    await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).result;
  const grouped = Object.values(TOOL_GROUPS).flat();
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...grouped].sort());
});

test("docs/tools.md lists the tool groups as the server defines them", async () => {
  const docs = await readFile(
    new URL("../docs/tools.md", import.meta.url),
    "utf8",
  );
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    const row = docs
      .split("\n")
      .find((line) => line.startsWith(`| \`${group}\``));
    assert.ok(row, `docs/tools.md has no row for ${group}`);
    const listed = [...row.split("|")[2].matchAll(/`([a-z_]+)`/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(listed, names, `docs/tools.md row for ${group}`);
  }
});

test("calling a tool outside the listed set says how to reach it", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "set_network", arguments: { sessionId: "s" } },
  });
  assert.match(
    response.error?.message ?? response.result?.content?.[0]?.text,
    /set_network is not listed directly; call it through more_tools .* or as a run_steps step, or list it with MCP_BROWSER_TOOLS=network/,
  );
});

test("evaluate_js turned off says which setting did it", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_ENABLE_EVAL: "0" }),
    browserAdapter: createFakeManager(),
  });
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "evaluate_js",
      arguments: { sessionId: "s", expression: "1" },
    },
  });
  assert.match(
    response.error?.message ?? response.result?.content?.[0]?.text,
    /turned off by MCP_BROWSER_ENABLE_EVAL=0/,
  );
});

function defaultServer(manager = createFakeManager()) {
  return new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
}

async function call(server, name, args) {
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return response;
}

test("more_tools lists the tools not listed, and describes one", async () => {
  const server = defaultServer();
  const listed = (await call(server, "more_tools", {})).result
    .structuredContent;
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("set_network"));
  assert.ok(names.includes("drag"));
  assert.ok(!names.includes("click"));
  const drag = listed.tools.find((tool) => tool.name === "drag");
  assert.equal(drag.group, "input");
  assert.match(drag.description, /^Drag with real mouse input/);
  assert.doesNotMatch(drag.description, /Returns changes/);

  const described = (await call(server, "more_tools", { name: "set_network" }))
    .result.structuredContent;
  assert.equal(described.name, "set_network");
  assert.equal(described.group, "network");
  assert.ok(described.inputSchema.properties.rules);
  assert.doesNotMatch(
    JSON.stringify(described),
    /"additionalProperties":false/,
  );

  const unknown = await call(server, "more_tools", { name: "click" });
  assert.match(
    unknown.error?.message ?? unknown.result?.content?.[0]?.text,
    /not one of the tools more_tools offers/,
  );
});

test("more_tools calls a hidden tool, checking its arguments", async () => {
  const manager = createFakeManager();
  const calls = [];
  manager.setNetwork = async (sessionId, options) => {
    calls.push([sessionId, options]);
    return { rules: [], headers: [], offline: true };
  };
  const server = defaultServer(manager);

  const response = await call(server, "more_tools", {
    name: "set_network",
    arguments: { sessionId: "s", offline: true },
  });
  assert.deepEqual(response.result.structuredContent, {
    rules: [],
    headers: [],
    offline: true,
  });
  assert.deepEqual(calls, [["s", { offline: true }]]);

  const invalid = await call(server, "more_tools", {
    name: "set_network",
    arguments: { sessionId: "s", offline: "yes" },
  });
  assert.match(
    invalid.error?.message ?? invalid.result?.content?.[0]?.text,
    /arguments\.arguments\.offline must be a boolean/,
  );
});

test("run_steps steps can use tools that are not listed", async () => {
  const manager = createFakeManager();
  manager.setNetwork = async () => ({ rules: [], headers: [], offline: true });
  const server = defaultServer(manager);
  const response = await call(server, "run_steps", {
    sessionId: "s",
    steps: [{ tool: "set_network", arguments: { offline: true } }],
  });
  assert.equal(response.result.structuredContent.ok, true);
  assert.equal(response.result.structuredContent.steps[0].result.offline, true);
});

test("more_tools is not offered when every tool is listed", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });
  const { tools } = (
    await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).result;
  assert.equal(
    tools.some((tool) => tool.name === "more_tools"),
    false,
  );
});

test("more_tools refuses arguments without a tool name", async () => {
  const response = await call(defaultServer(), "more_tools", {
    arguments: { sessionId: "s" },
  });
  assert.match(
    response.error?.message ?? response.result?.content?.[0]?.text,
    /needs name to call a tool/,
  );
});
