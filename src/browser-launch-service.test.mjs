import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.mjs";
import {
  launchBrowser,
  resolveLaunchFamily,
  supportedLaunchFamilies,
} from "./browser-launch-service.mjs";

test("supportedLaunchFamilies matches the configured broker family", () => {
  assert.deepEqual(supportedLaunchFamilies("chromium"), ["chromium", "edge"]);
  assert.deepEqual(supportedLaunchFamilies("edge"), ["chromium", "edge"]);
  assert.deepEqual(supportedLaunchFamilies("firefox"), ["firefox"]);
  assert.deepEqual(supportedLaunchFamilies("auto"), [
    "chromium",
    "edge",
    "firefox",
  ]);
});

test("resolveLaunchFamily requires browserFamily in auto mode", () => {
  assert.throws(
    () => resolveLaunchFamily("auto", null),
    /browserFamily is required/,
  );
  assert.equal(resolveLaunchFamily("edge", "chromium"), "chromium");
  assert.throws(
    () => resolveLaunchFamily("firefox", "edge"),
    /browserFamily must be one of: firefox/,
  );
});

test("launchBrowser launches a Chromium browser and returns a doctor report", async () => {
  let spawnOptions = null;
  let unrefCalled = false;
  let collectedDoctorEnv = null;
  let collectedDoctorUrl = null;

  const result = await launchBrowser(
    {
      config: loadConfig({}),
      browserFamily: "chromium",
      url: "https://example.com/app",
      waitMs: 0,
    },
    {
      execFileFn: async () => ({ stdout: "" }),
      findBrowserExecutableFn: async () => "/usr/bin/chromium",
      spawnProcess: (command, args, options) => {
        spawnOptions = { command, args, options };
        return {
          pid: 4321,
          unref() {
            unrefCalled = true;
          },
        };
      },
      collectDoctorReportFn: async ({ env, url }) => {
        collectedDoctorEnv = env;
        collectedDoctorUrl = url;
        return {
          browserStatus: {
            available: true,
          },
        };
      },
    },
  );

  assert.equal(spawnOptions.command, "/usr/bin/chromium");
  assert.deepEqual(spawnOptions.args, [
    "--remote-debugging-port=9222",
    "https://example.com/app",
  ]);
  assert.deepEqual(spawnOptions.options, {
    detached: true,
    stdio: "ignore",
  });
  assert.equal(unrefCalled, true);
  assert.equal(collectedDoctorEnv.MCP_BROWSER_FAMILY, "chromium");
  assert.equal(collectedDoctorEnv.CDP_BASE_URL, "http://127.0.0.1:9222");
  assert.equal(collectedDoctorUrl, "https://example.com/app");
  assert.equal(result.browserFamily, "chromium");
  assert.equal(result.pid, 4321);
  assert.equal(result.endpoint, "http://127.0.0.1:9222");
  assert.equal(result.userDataDir, null);
  assert.equal(result.profileStrategy, "default");
  assert.equal(result.existingBrowserProcess.detected, false);
  assert.equal(result.doctorReport.browserStatus.available, true);
});

test("launchBrowser skips doctor checks when requested", async () => {
  let doctorCalled = false;

  const result = await launchBrowser(
    {
      config: loadConfig({ MCP_BROWSER_FAMILY: "firefox" }),
      browserFamily: "firefox",
      skipDoctor: true,
    },
    {
      execFileFn: async () => ({ stdout: "" }),
      findBrowserExecutableFn: async () => "/usr/bin/firefox",
      spawnProcess: () => ({
        pid: 99,
        unref() {},
      }),
      collectDoctorReportFn: async () => {
        doctorCalled = true;
        return {};
      },
    },
  );

  assert.equal(result.endpoint, "ws://127.0.0.1:9222");
  assert.equal(result.doctorReport, null);
  assert.equal(doctorCalled, false);
});

test("launchBrowser rejects unsafeArgs unless explicitly enabled", async () => {
  await assert.rejects(
    launchBrowser(
      {
        config: loadConfig({}),
        browserFamily: "chromium",
        unsafeArgs: ["--remote-allow-origins=http://localhost:9222"],
      },
      {
        execFileFn: async () => ({ stdout: "" }),
        findBrowserExecutableFn: async () => "/usr/bin/chromium",
      },
    ),
    /MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1/,
  );
});

test("launchBrowser passes unsafeArgs through when explicitly enabled", async () => {
  let spawnOptions = null;

  const result = await launchBrowser(
    {
      config: loadConfig({
        MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
      }),
      browserFamily: "chromium",
      unsafeArgs: ["--remote-allow-origins=http://localhost:9222"],
      waitMs: 0,
    },
    {
      execFileFn: async () => ({ stdout: "" }),
      findBrowserExecutableFn: async () => "/usr/bin/chromium",
      spawnProcess: (command, args, options) => {
        spawnOptions = { command, args, options };
        return {
          pid: 88,
          unref() {},
        };
      },
      collectDoctorReportFn: async () => ({
        browserStatus: {
          available: true,
        },
      }),
    },
  );

  assert.deepEqual(spawnOptions.args, [
    "--remote-debugging-port=9222",
    "--remote-allow-origins=http://localhost:9222",
    "about:blank",
  ]);
  assert.deepEqual(result.unsafeArgs, [
    "--remote-allow-origins=http://localhost:9222",
  ]);
});

test("launchBrowser rejects unsafeArgs that conflict with broker-managed flags", async () => {
  await assert.rejects(
    launchBrowser(
      {
        config: loadConfig({
          MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
        }),
        browserFamily: "chromium",
        unsafeArgs: ["--remote-debugging-port=9333"],
      },
      {
        execFileFn: async () => ({ stdout: "" }),
        findBrowserExecutableFn: async () => "/usr/bin/chromium",
      },
    ),
    /conflicts with broker-managed launch options/,
  );
});

test("launchBrowser auto-creates a temporary Chromium profile when the browser is already running", async () => {
  let spawnOptions = null;

  const result = await launchBrowser(
    {
      config: loadConfig({}),
      browserFamily: "chromium",
      url: "https://example.com/app",
      waitMs: 0,
    },
    {
      execFileFn: async () => ({ stdout: "chrome\n" }),
      findBrowserExecutableFn: async () => "/usr/bin/chromium",
      mkdtempFn: async (prefix) => `${prefix}abcd1234`,
      tmpdirFn: () => "/tmp",
      spawnProcess: (command, args, options) => {
        spawnOptions = { command, args, options };
        return {
          pid: 77,
          unref() {},
        };
      },
      collectDoctorReportFn: async () => ({
        browserStatus: {
          available: true,
        },
      }),
    },
  );

  assert.equal(spawnOptions.command, "/usr/bin/chromium");
  assert.deepEqual(spawnOptions.args, [
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/mcp-browser-dev-tools-chromium-abcd1234",
    "https://example.com/app",
  ]);
  assert.equal(
    result.userDataDir,
    "/tmp/mcp-browser-dev-tools-chromium-abcd1234",
  );
  assert.equal(result.profileStrategy, "temporary");
  assert.equal(result.existingBrowserProcess.detected, true);
  assert.deepEqual(result.existingBrowserProcess.matches, ["chrome"]);
});
