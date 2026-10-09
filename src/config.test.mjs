import test from "node:test";

import { TOOL_GROUPS } from "./tool-sets.mjs";
import assert from "node:assert/strict";

import {
  DEFAULT_BROWSER_FAMILY,
  DEFAULT_CDP_BASE_URL,
  DEFAULT_EVENT_BUFFER_SIZE,
  DEFAULT_FIREFOX_BIDI_WS_URL,
  DEFAULT_LOG_LEVEL,
  isLoopbackHost,
  isLoopbackOrigin,
  loadConfig,
  loadLoggingConfig,
  normalizeWebSocketUrl,
  parseBrowserFamily,
  parseLogLevel,
  normalizeBaseUrl,
  parsePositiveInteger,
} from "./config.mjs";

test("parsePositiveInteger rejects invalid values", () => {
  assert.equal(parsePositiveInteger(undefined, 9), 9);
  assert.equal(parsePositiveInteger("", 9), 9);
  assert.equal(parsePositiveInteger("abc", 9), 9);
  assert.equal(parsePositiveInteger("0", 9), 9);
  assert.equal(parsePositiveInteger("-1", 9), 9);
  assert.equal(parsePositiveInteger("16", 9), 16);
});

test("normalizeBaseUrl trims trailing slashes", () => {
  assert.equal(
    normalizeBaseUrl("http://127.0.0.1:9222/"),
    DEFAULT_CDP_BASE_URL,
  );
});

test("normalizeWebSocketUrl trims trailing slashes", () => {
  assert.equal(
    normalizeWebSocketUrl("ws://127.0.0.1:9222/"),
    DEFAULT_FIREFOX_BIDI_WS_URL,
  );
});

test("isLoopbackOrigin accepts loopback hosts only", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:9222"), true);
  assert.equal(isLoopbackOrigin("http://localhost:9222"), true);
  assert.equal(isLoopbackOrigin("ws://localhost:9222"), true);
  assert.equal(isLoopbackOrigin("ws://[::1]:9222"), true);
  assert.equal(isLoopbackOrigin("http://192.0.2.10:9222"), false);
});

test("isLoopbackHost accepts loopback hostnames only", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("parseBrowserFamily falls back to auto", () => {
  assert.equal(parseBrowserFamily("chromium"), "chromium");
  assert.equal(parseBrowserFamily("edge"), "edge");
  assert.equal(parseBrowserFamily("firefox"), "firefox");
  assert.equal(parseBrowserFamily("auto"), "auto");
  assert.equal(parseBrowserFamily("webkit"), DEFAULT_BROWSER_FAMILY);
});

test("parseLogLevel falls back to error", () => {
  assert.equal(parseLogLevel("error"), "error");
  assert.equal(parseLogLevel("warn"), "warn");
  assert.equal(parseLogLevel("info"), "info");
  assert.equal(parseLogLevel("debug"), "debug");
  assert.equal(parseLogLevel("trace"), DEFAULT_LOG_LEVEL);
});

test("loadConfig applies defaults", () => {
  assert.deepEqual(loadConfig({}), {
    browserFamily: "auto",
    cdpBaseUrl: DEFAULT_CDP_BASE_URL,
    firefoxBidiWsUrl: DEFAULT_FIREFOX_BIDI_WS_URL,
    allowRemoteEndpoints: false,
    allowRemoteCdp: false,
    enableEvaluate: true,
    enableUnsafeLaunchArgs: false,
    eventBufferSize: DEFAULT_EVENT_BUFFER_SIZE,
    logLevel: DEFAULT_LOG_LEVEL,
    debugStdio: false,
    logFile: null,
    tools: new Set(TOOL_GROUPS.core),
    userDataDir: null,
    uploadDirs: [],
    timingLogFile: null,
    ffmpegPath: null,
    protocolVersion: "2024-11-05",
  });
});

test("MCP_BROWSER_TOOLS adds groups and tools to the core set, or enables all", () => {
  assert.equal(loadConfig({ MCP_BROWSER_TOOLS: "all" }).tools, null);
  const tools = loadConfig({ MCP_BROWSER_TOOLS: "network, drag" }).tools;
  assert.equal(tools.has("set_network"), true);
  assert.equal(tools.has("get_har"), true);
  assert.equal(tools.has("drag"), true);
  assert.equal(tools.has("click"), true);
  assert.equal(tools.has("get_cookies"), false);
  assert.throws(
    () => loadConfig({ MCP_BROWSER_TOOLS: "netwrok" }),
    /unknown group or tool: netwrok/,
  );
  assert.throws(
    () => loadConfig({ MCP_BROWSER_TOOLS: "all,netwrok" }),
    /unknown group or tool: netwrok/,
  );
});

test("loadLoggingConfig reads logger-related environment flags", () => {
  assert.deepEqual(
    loadLoggingConfig({
      MCP_BROWSER_LOG_LEVEL: "debug",
      MCP_BROWSER_DEBUG_STDIO: "1",
      MCP_BROWSER_LOG_FILE: "/tmp/broker.log",
    }),
    {
      logLevel: "debug",
      debugStdio: true,
      logFile: "/tmp/broker.log",
    },
  );
});

test("loadLoggingConfig defaults logFile to null", () => {
  assert.equal(loadLoggingConfig({}).logFile, null);
});

test("loadConfig rejects non-loopback CDP endpoints by default", () => {
  assert.throws(
    () => loadConfig({ CDP_BASE_URL: "http://192.0.2.10:9222" }),
    /loopback host/,
  );
});

test("loadConfig allows non-loopback CDP endpoints when explicitly enabled", () => {
  const config = loadConfig({
    CDP_BASE_URL: "http://192.0.2.10:9222",
    MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS: "1",
    MCP_BROWSER_ENABLE_EVAL: "true",
  });

  assert.equal(config.cdpBaseUrl, "http://192.0.2.10:9222");
  assert.equal(config.allowRemoteEndpoints, true);
  assert.equal(config.allowRemoteCdp, true);
  assert.equal(config.enableEvaluate, true);
});

test("loadConfig turns evaluate_js off only for 0 or false", () => {
  assert.equal(
    loadConfig({ MCP_BROWSER_ENABLE_EVAL: "0" }).enableEvaluate,
    false,
  );
  assert.equal(
    loadConfig({ MCP_BROWSER_ENABLE_EVAL: "false" }).enableEvaluate,
    false,
  );
  assert.equal(
    loadConfig({ MCP_BROWSER_ENABLE_EVAL: "1" }).enableEvaluate,
    true,
  );
});

test("loadConfig reads the unsafe launch args gate", () => {
  const config = loadConfig({
    MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
  });

  assert.equal(config.enableUnsafeLaunchArgs, true);
});

test("loadConfig rejects non-loopback Firefox BiDi endpoints by default", () => {
  assert.throws(
    () =>
      loadConfig({
        MCP_BROWSER_FAMILY: "firefox",
        FIREFOX_BIDI_WS_URL: "ws://192.0.2.10:9222",
      }),
    /loopback host/,
  );
});

test("loadConfig accepts Firefox BiDi endpoints when explicitly enabled", () => {
  const config = loadConfig({
    MCP_BROWSER_FAMILY: "firefox",
    FIREFOX_BIDI_WS_URL: "ws://192.0.2.10:9222",
    MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS: "1",
  });

  assert.equal(config.browserFamily, "firefox");
  assert.equal(config.firefoxBidiWsUrl, "ws://192.0.2.10:9222");
  assert.equal(config.allowRemoteEndpoints, true);
  assert.equal(config.allowRemoteCdp, true);
});

test("loadConfig accepts auto mode and keeps both endpoints", () => {
  const config = loadConfig({
    MCP_BROWSER_FAMILY: "auto",
    CDP_BASE_URL: "http://127.0.0.1:9222",
    FIREFOX_BIDI_WS_URL: "ws://127.0.0.1:9333",
  });

  assert.equal(config.browserFamily, "auto");
  assert.equal(config.cdpBaseUrl, "http://127.0.0.1:9222");
  assert.equal(config.firefoxBidiWsUrl, "ws://127.0.0.1:9333");
});

test("loadConfig validates both endpoints in auto mode", () => {
  assert.throws(
    () =>
      loadConfig({
        MCP_BROWSER_FAMILY: "auto",
        CDP_BASE_URL: "http://192.0.2.10:9222",
      }),
    /CDP_BASE_URL must point to a loopback host/,
  );

  assert.throws(
    () =>
      loadConfig({
        MCP_BROWSER_FAMILY: "auto",
        FIREFOX_BIDI_WS_URL: "ws://192.0.2.11:9222",
      }),
    /FIREFOX_BIDI_WS_URL must point to a loopback host/,
  );
});

test("loadConfig still accepts the legacy remote endpoint flag", () => {
  const config = loadConfig({
    CDP_BASE_URL: "http://192.0.2.10:9222",
    MCP_BROWSER_ALLOW_REMOTE_CDP: "1",
  });

  assert.equal(config.allowRemoteEndpoints, true);
  assert.equal(config.allowRemoteCdp, true);
});

test("loadConfig reads the default browser profile from MCP_BROWSER_USER_DATA_DIR", () => {
  assert.equal(
    loadConfig({ MCP_BROWSER_USER_DATA_DIR: " ~/chrome-debug-profile " })
      .userDataDir,
    "~/chrome-debug-profile",
  );
  assert.equal(
    loadConfig({ MCP_BROWSER_USER_DATA_DIR: " " }).userDataDir,
    null,
  );
});
