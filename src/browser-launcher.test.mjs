import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBrowserLaunchArgs,
  getBrowserCandidates,
} from "./browser-launcher.mjs";

test("getBrowserCandidates includes WSL Chrome paths for Chromium", () => {
  const candidates = getBrowserCandidates("chromium", {
    PATH: "/usr/bin",
    WSL_INTEROP: "/run/WSL/1_interop",
  });

  assert.deepEqual(candidates.slice(0, 2), ["chromium-browser", "chromium"]);
  assert.equal(
    candidates.includes(
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    ),
    true,
  );
});

test("getBrowserCandidates uses native Windows executable paths on win32", () => {
  const candidates = getBrowserCandidates("chromium", {}, "win32");

  assert.equal(
    candidates.includes(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ),
    true,
  );
  assert.equal(
    candidates.includes(
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    ),
    false,
  );
});

test("buildBrowserLaunchArgs builds Chromium args", () => {
  assert.deepEqual(
    buildBrowserLaunchArgs({
      family: "chromium",
      url: "http://127.0.0.1:3000",
      remoteDebuggingPort: "9222",
      remoteDebuggingAddress: "127.0.0.1",
      userDataDir: "/tmp/profile",
    }),
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/profile",
      "http://127.0.0.1:3000",
    ],
  );
});

test("buildBrowserLaunchArgs builds Firefox args", () => {
  assert.deepEqual(
    buildBrowserLaunchArgs({
      family: "firefox",
      url: "http://127.0.0.1:3000",
      remoteDebuggingPort: "9222",
    }),
    ["--remote-debugging-port=9222", "http://127.0.0.1:3000"],
  );
});

test("buildBrowserLaunchArgs uses a dedicated Firefox profile when requested", () => {
  assert.deepEqual(
    buildBrowserLaunchArgs({
      family: "firefox",
      url: "http://127.0.0.1:3000",
      remoteDebuggingPort: "9222",
      userDataDir: "/tmp/profile",
    }),
    [
      "-new-instance",
      "-profile",
      "/tmp/profile",
      "--remote-debugging-port=9222",
      "http://127.0.0.1:3000",
    ],
  );
});
