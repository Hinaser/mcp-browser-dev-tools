import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { findBrowserExecutable } from "./browser-launcher.mjs";
import { CdpSessionManager } from "./cdp-client.mjs";
import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { callTool } from "./mcp-test-support.mjs";
import { findFfmpeg } from "./video-output.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A throwaway headless Chrome with its own profile on a free port, never
// a browser someone is using.
async function startChrome(executable, port, profile) {
  const chrome = spawn(
    executable,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = null;
  chrome.once("error", (error) => {
    exited = error.message;
  });
  chrome.once("exit", (code, signal) => {
    exited = `exit ${signal ?? code}`;
  });
  for (let attempt = 0; attempt < 100 && !exited; attempt += 1) {
    const answers = await fetch(`http://127.0.0.1:${port}/json/version`).then(
      (response) => response.ok,
      () => false,
    );
    if (answers) {
      return chrome;
    }
    await sleep(100);
  }
  chrome.kill();
  throw new Error(`Chrome did not expose port ${port}: ${exited}`);
}

const ANIMATION_PAGE = `<!doctype html><html><body style="margin:0;background:#123">
<div style="width:200px;height:200px;background:orange;animation:spin 1s linear infinite"></div>
<style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>
</body></html>`;

// Records a CSS animation for about 2 s at a 1920x1080 viewport override
// and checks the MP4 with ffprobe. Skipped without Chrome or ffmpeg.
test("record_video records a page to an MP4 of the viewport's size and the capture's length", async (t) => {
  const chromeExecutable = await findBrowserExecutable("chromium");
  const ffmpeg = await findFfmpeg({});
  const ffprobe = ffmpeg && path.join(path.dirname(ffmpeg), "ffprobe");
  if (!chromeExecutable || !ffmpeg) {
    t.skip(
      `needs Chrome and ffmpeg (chrome: ${chromeExecutable ?? "none"}, ffmpeg: ${ffmpeg ?? "none"})`,
    );
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "record-video-test-"));
  const port = await freePort();
  const chrome = await startChrome(
    chromeExecutable,
    port,
    path.join(workDir, "profile"),
  );
  const config = loadConfig({
    MCP_BROWSER_FAMILY: "chromium",
    CDP_BASE_URL: `http://127.0.0.1:${port}`,
    MCP_BROWSER_TOOLS: "all",
  });
  const manager = new CdpSessionManager(config);
  const server = new McpBrowserDevToolsServer({
    config,
    browserAdapter: manager,
  });
  t.after(async () => {
    await manager.closeAll();
    chrome.kill();
    await new Promise((resolve) => chrome.once("exit", resolve));
    await rm(workDir, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const response = await callTool(server, name, args);
    assert.equal(
      response.error,
      undefined,
      `${name}: ${response.error?.message}`,
    );
    return response.result.structuredContent;
  };

  const tab = await call("new_tab", {
    url: `data:text/html,${encodeURIComponent(ANIMATION_PAGE)}`,
  });
  const { sessionId } = await call("attach_tab", { targetId: tab.targetId });
  await call("set_viewport", { sessionId, width: 1920, height: 1080 });
  const started = await call("record_video", { sessionId, action: "start" });
  assert.equal(started.recording, true);
  await sleep(2000);
  const output = path.join(workDir, "demo.mp4");
  const stopped = await call("record_video", {
    sessionId,
    action: "stop",
    path: output,
  });
  assert.equal(stopped.path, output, stopped.error);
  assert.ok(stopped.frames > 10, `only ${stopped.frames} frames`);
  assert.deepEqual([stopped.width, stopped.height], [1920, 1080]);
  assert.deepEqual(stopped.warnings, undefined);

  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration",
    "-of",
    "json",
    output,
  ]);
  const probe = JSON.parse(stdout);
  const [stream] = probe.streams;
  assert.equal(stream.codec_name, "h264");
  assert.deepEqual([stream.width, stream.height], [1920, 1080]);
  assert.equal(stream.pix_fmt, "yuv420p");
  assert.equal(stream.r_frame_rate, "30/1");
  const durationS = Number(probe.format.duration);
  assert.ok(
    Math.abs(durationS - stopped.durationMs / 1000) < 0.1,
    `ffprobe duration ${durationS} s, recorded ${stopped.durationMs} ms`,
  );
  assert.ok(durationS >= 1.9 && durationS <= 2.6, `duration ${durationS} s`);
});
