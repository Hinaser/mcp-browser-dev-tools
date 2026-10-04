import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config.mjs";
import { McpBrowserDevToolsServer } from "../mcp-server.mjs";
import { callTool, createFakeManager } from "../mcp-test-support.mjs";

function traceServer() {
  const manager = createFakeManager();
  manager.startTrace = async () => ({ recording: true });
  manager.stopTrace = async () => ({
    data: Buffer.from('{"traceEvents":[]}'),
    durationMs: 120,
  });
  return new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "performance" }),
    browserAdapter: manager,
  });
}

test("record_trace writes the trace to a private file", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "trace-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = traceServer();
  const call = async (args) =>
    (await callTool(server, "record_trace", { sessionId: "s", ...args })).result
      ?.structuredContent;

  assert.deepEqual(await call({ action: "start" }), { recording: true });
  const file = path.join(dir, "run.json");
  const stopped = await call({ action: "stop", path: file });
  assert.deepEqual(stopped, { path: file, bytes: 18, durationMs: 120 });
  assert.equal(await readFile(file, "utf8"), '{"traceEvents":[]}');

  const temp = await call({ action: "stop" });
  assert.match(temp.path, /trace\.json$/);
  await rm(path.dirname(temp.path), { recursive: true, force: true });
});

test("record_trace refuses relative or non-JSON paths", async () => {
  const server = traceServer();
  for (const filePath of ["trace.json", "/tmp/trace.txt"]) {
    const response = await callTool(server, "record_trace", {
      sessionId: "s",
      action: "stop",
      path: filePath,
    });
    assert.match(
      response.error?.message ?? response.result?.content?.[0]?.text,
      /absolute and end in \.json/,
    );
  }
});

test("record_trace checks the path before stopping, so a bad path keeps the trace", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "trace-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const existing = path.join(dir, "taken.json");
  await writeFile(existing, "{}");
  let stops = 0;
  const manager = createFakeManager();
  manager.stopTrace = async () => {
    stops += 1;
    return { data: Buffer.from("{}"), durationMs: 1 };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "performance" }),
    browserAdapter: manager,
  });

  const refused = await callTool(server, "record_trace", {
    sessionId: "s",
    action: "stop",
    path: existing,
  });
  assert.match(
    refused.error?.message ?? refused.result?.content?.[0]?.text,
    /already exists/,
  );
  assert.equal(stops, 0);
});
