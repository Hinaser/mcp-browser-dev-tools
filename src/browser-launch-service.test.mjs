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

function launchDeps({ processes = [], available, spawned }) {
  const psColumns = (column) =>
    processes.map((entry) => `${entry.pid} ${entry[column]}`).join("\n");
  return {
    execFileFn: async (command, args = []) => {
      const format = args[2];
      if (command === "ps" && format === "pid=,comm=") {
        return { stdout: psColumns("comm") };
      }
      if (command === "ps" && format === "pid=,command=") {
        return { stdout: psColumns("command") };
      }
      return { stdout: processes.map((entry) => entry.name).join("\n") };
    },
    realpathFn: async (dir) => dir,
    findBrowserExecutableFn: async () => "/usr/bin/chromium",
    spawnProcess: (command, args) => {
      spawned.push(args);
      return { pid: 88, unref() {} };
    },
    collectDoctorReportFn: async () => ({
      browserStatus: { available },
    }),
    sleepFn: async () => {},
  };
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("launchBrowser uses MCP_BROWSER_USER_DATA_DIR when no userDataDir is passed", async () => {
  const spawned = [];
  const deps = launchDeps({ available: true, spawned });

  const result = await launchBrowser(
    {
      config: loadConfig({ MCP_BROWSER_USER_DATA_DIR: "/profiles/debug" }),
      browserFamily: "chromium",
      waitMs: 0,
    },
    deps,
  );

  assert.equal(result.launched, true);
  assert.equal(result.profileStrategy, "provided");
  assert.ok(spawned[0].includes("--user-data-dir=/profiles/debug"));
});

test("launchBrowser reuses a running browser on the same profile instead of opening another window", async () => {
  const spawned = [];
  const deps = launchDeps({
    processes: [
      {
        pid: 501,
        name: "Google Chrome",
        comm: CHROME,
        command: `${CHROME} --remote-debugging-port=9222 --user-data-dir=/profiles/debug about:blank`,
      },
    ],
    available: true,
    spawned,
  });

  const result = await launchBrowser(
    {
      config: loadConfig({}),
      browserFamily: "chromium",
      userDataDir: "/profiles/debug/",
      waitMs: 0,
    },
    deps,
  );

  assert.deepEqual(spawned, []);
  assert.equal(result.launched, false);
  assert.equal(result.profileAlreadyRunning, true);
  assert.equal(result.pid, null);
});

test("launchBrowser refuses to relaunch a running profile whose endpoint is down", async () => {
  const spawned = [];
  const deps = launchDeps({
    processes: [
      {
        pid: 502,
        name: "chrome",
        comm: "chrome",
        command: "chrome --user-data-dir=/profiles/debug",
      },
    ],
    available: false,
    spawned,
  });

  await assert.rejects(
    launchBrowser(
      {
        config: loadConfig({}),
        browserFamily: "chromium",
        userDataDir: "/profiles/debug",
        waitMs: 0,
      },
      deps,
    ),
    /already running with profile \/profiles\/debug.*nothing was launched/,
  );
  assert.deepEqual(spawned, []);
});

test("launchBrowser does not treat a profile whose path only shares a prefix as running", async () => {
  const spawned = [];
  const deps = launchDeps({
    processes: [
      {
        pid: 503,
        name: "chrome",
        comm: "chrome",
        command: "chrome --user-data-dir=/profiles/debug-old",
      },
    ],
    available: true,
    spawned,
  });

  const result = await launchBrowser(
    {
      config: loadConfig({}),
      browserFamily: "chromium",
      userDataDir: "/profiles/debug",
      waitMs: 0,
    },
    deps,
  );

  assert.equal(result.launched, true);
  assert.equal(spawned.length, 1);
});

test("launchBrowser does not start Firefox without a profile while Firefox is running", async () => {
  const spawned = [];
  const deps = launchDeps({
    processes: [
      { pid: 504, name: "firefox", comm: "firefox", command: "firefox" },
    ],
    available: false,
    spawned,
  });
  deps.resolveFirefoxDoctorEndpointFn = async () => "ws://127.0.0.1:9222";

  await assert.rejects(
    launchBrowser(
      { config: loadConfig({}), browserFamily: "firefox", waitMs: 0 },
      deps,
    ),
    /firefox is already running.*nothing was launched/,
  );
  assert.deepEqual(spawned, []);
});

test("launchBrowser ignores non-browser processes that mention the profile", async () => {
  const spawned = [];
  const deps = launchDeps({
    processes: [
      {
        pid: 505,
        name: "node",
        comm: "node",
        command:
          "node /usr/lib/mcp-browser-dev-tools/cli.mjs open https://example.com --user-data-dir=/profiles/debug",
      },
    ],
    available: true,
    spawned,
  });

  const result = await launchBrowser(
    {
      config: loadConfig({}),
      browserFamily: "chromium",
      userDataDir: "/profiles/debug",
      waitMs: 0,
    },
    deps,
  );

  assert.equal(result.launched, true);
  assert.equal(spawned.length, 1);
});
