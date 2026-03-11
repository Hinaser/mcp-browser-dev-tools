import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseCliArgs,
  parseFirefoxBidiServerInfo,
  resolveFirefoxDoctorEndpoint,
  runCli,
} from "./cli.mjs";
import { PACKAGE_VERSION } from "./package-info.mjs";

test("parseCliArgs defaults to serve", () => {
  assert.deepEqual(parseCliArgs([]), {
    command: "serve",
    positional: [],
    options: {},
  });
});

test("parseCliArgs parses positional arguments and flags", () => {
  assert.deepEqual(
    parseCliArgs([
      "open",
      "http://127.0.0.1:3000",
      "--family",
      "firefox",
      "--port=9222",
      "--wait-ms",
      "2000",
      "--no-doctor",
    ]),
    {
      command: "open",
      positional: ["http://127.0.0.1:3000"],
      options: {
        family: "firefox",
        port: "9222",
        "wait-ms": "2000",
        "no-doctor": true,
      },
    },
  );
});

test("runCli prints usage for top-level --help", async () => {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await runCli(["--help"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(output, /Usage: mcp-browser-dev-tools/);
});

test("runCli prints the package version for top-level --version", async () => {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await runCli(["--version"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(output.trim(), PACKAGE_VERSION);
});

test("runCli rejects non-loopback remote debugging addresses by default", async () => {
  await assert.rejects(
    runCli([
      "open",
      "https://example.com",
      "--family",
      "chromium",
      "--address",
      "0.0.0.0",
    ]),
    /MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1/,
  );
});

test("runCli rejects non-loopback relay listen hosts by default", async () => {
  await assert.rejects(
    runCli(["relay", "--listen-host", "0.0.0.0"]),
    /MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1/,
  );
});

test("parseFirefoxBidiServerInfo converts Firefox server metadata into an endpoint URL", () => {
  assert.equal(
    parseFirefoxBidiServerInfo(
      JSON.stringify({
        ws_host: "127.0.0.1",
        ws_port: 9321,
      }),
    ),
    "ws://127.0.0.1:9321",
  );
});

test("parseFirefoxBidiServerInfo preserves direct websocket session URLs", () => {
  assert.equal(
    parseFirefoxBidiServerInfo(
      JSON.stringify({
        webSocketUrl: "ws://127.0.0.1:9222/session/direct",
      }),
    ),
    "ws://127.0.0.1:9222/session/direct",
  );
});

test("resolveFirefoxDoctorEndpoint reads Firefox server info from the launched profile", async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "firefox-bidi-"));
  await writeFile(
    path.join(profileDir, "WebDriverBiDiServer.json"),
    JSON.stringify({
      ws_host: "127.0.0.1",
      ws_port: 9555,
    }),
    "utf8",
  );

  assert.equal(
    await resolveFirefoxDoctorEndpoint({
      userDataDir: profileDir,
      fallbackPort: "9222",
    }),
    "ws://127.0.0.1:9555",
  );
});

test("resolveFirefoxDoctorEndpoint falls back to the requested port until Firefox publishes server info", async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "firefox-bidi-"));

  assert.equal(
    await resolveFirefoxDoctorEndpoint({
      userDataDir: profileDir,
      fallbackPort: "9222",
    }),
    "ws://127.0.0.1:9222",
  );
});
