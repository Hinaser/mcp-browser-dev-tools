import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config.mjs";
import { FirefoxBidiSessionManager } from "../firefox-bidi-client.mjs";
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

// A fake ffmpeg that writes its last argument, so the tool's file handling
// is tested without encoding.
async function fakeFfmpeg(dir) {
  const file = path.join(dir, "ffmpeg");
  await writeFile(
    file,
    '#!/bin/sh\nfor last; do :; done\necho mp4 > "$last"\n',
  );
  await chmod(file, 0o755);
  return file;
}

async function videoFrames(dir) {
  const framesDir = path.join(dir, `frames-${Math.random()}`);
  await mkdir(framesDir);
  await writeFile(path.join(framesDir, "000000.jpg"), "jpeg");
  return {
    dir: framesDir,
    frames: [{ file: "000000.jpg", timestamp: 10 }],
    startedAt: 10,
    stoppedAt: 12.5,
    fps: 30,
    width: 1920,
    height: 1080,
    warnings: [],
  };
}

function videoServer(env, framesDir) {
  const manager = createFakeManager();
  const calls = { starts: [], stops: 0 };
  manager.startVideo = async (sessionId, options) => {
    calls.starts.push(options);
    return { recording: true, dir: "/tmp/frames", width: 1, height: 1 };
  };
  manager.stopVideo = async () => {
    calls.stops += 1;
    return videoFrames(framesDir);
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "performance", ...env }),
    browserAdapter: manager,
  });
  const call = async (args) => {
    const response = await callTool(server, "record_video", {
      sessionId: "s",
      ...args,
    });
    return response.error
      ? { error: response.error.message }
      : response.result.structuredContent;
  };
  return { call, calls };
}

test("record_video starts with its options and encodes to a private file on stop", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call, calls } = videoServer(
    { MCP_BROWSER_FFMPEG: await fakeFfmpeg(dir) },
    dir,
  );

  assert.deepEqual(
    await call({ action: "start", fps: 24, quality: 50, maxWidth: 1280 }),
    { recording: true, dir: "/tmp/frames" },
  );
  assert.deepEqual(calls.starts, [
    {
      fps: 24,
      quality: 50,
      maxWidth: 1280,
      maxHeight: undefined,
      maxDurationMs: undefined,
    },
  ]);

  const file = path.join(dir, "out", "demo.mp4");
  const stopped = await call({ action: "stop", path: file });
  assert.deepEqual(stopped, {
    path: file,
    durationMs: 2500,
    frames: 1,
    width: 1920,
    height: 1080,
  });
  assert.equal(await readFile(file, "utf8"), "mp4\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(
    await stat(path.join(dir, "frames")).then(
      () => true,
      () => false,
    ),
    false,
    "the frame directory is deleted after a successful encode",
  );

  const temp = await call({ action: "stop" });
  assert.match(temp.path, /video\.mp4$/);
  await rm(path.dirname(temp.path), { recursive: true, force: true });
});

test("record_video stop without ffmpeg keeps the frames and says where", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call } = videoServer(
    { MCP_BROWSER_FFMPEG: path.join(dir, "missing-ffmpeg") },
    dir,
  );
  const result = await call({ action: "stop" });
  assert.equal(result.path, undefined);
  assert.match(result.framesDir, /frames-/);
  assert.match(result.ffmpegCommand, /missing-ffmpeg .* -c:v libx264 /);
  assert.match(result.error, /frames are kept in framesDir/);
  assert.equal(result.frames, 1);
  assert.ok((await stat(path.join(result.framesDir, "000000.jpg"))).isFile());
});

test("record_video checks the path before stopping and never writes through a symlink", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call, calls } = videoServer(
    { MCP_BROWSER_FFMPEG: await fakeFfmpeg(dir) },
    dir,
  );
  for (const filePath of ["demo.mp4", "/tmp/demo.mov"]) {
    const { error } = await call({ action: "stop", path: filePath });
    assert.match(error, /absolute and end in \.mp4/);
  }
  const taken = path.join(dir, "taken.mp4");
  await writeFile(taken, "old");
  const { error } = await call({ action: "stop", path: taken });
  assert.match(error, /already exists/);
  assert.equal(calls.stops, 0);

  const victim = path.join(dir, "victim.txt");
  await writeFile(victim, "keep");
  const link = path.join(dir, "link.mp4");
  await symlink(victim, link);
  const replaced = await call({ action: "stop", path: link, overwrite: true });
  assert.equal(replaced.path, link);
  assert.equal((await lstat(link)).isSymbolicLink(), false);
  assert.equal(await readFile(link, "utf8"), "mp4\n");
  assert.equal(await readFile(victim, "utf8"), "keep");
});

test("record_video is refused on Firefox", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "performance",
      MCP_BROWSER_FAMILY: "firefox",
    }),
    browserAdapter: manager,
  });
  for (const action of ["start", "stop"]) {
    const response = await callTool(server, "record_video", {
      sessionId: "s",
      action,
    });
    assert.match(
      response.error?.message ?? response.result?.content?.[0]?.text,
      /record_video is Chromium only; WebDriver BiDi has no screencast/,
    );
  }
});
