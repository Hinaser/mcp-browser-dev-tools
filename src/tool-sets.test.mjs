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

test("calling a tool outside the offered set says how to enable it", async () => {
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
    /set_network is not enabled; it is in the network tool group, which MCP_BROWSER_TOOLS=network \(or all\) adds/,
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
