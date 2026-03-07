import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";

function splitPathEntries(value) {
  return value ? value.split(path.delimiter).filter(Boolean) : [];
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectPlatform(env = process.env) {
  const release = os.release().toLowerCase();
  if (process.platform === "linux" && (release.includes("microsoft") || env.WSL_INTEROP)) {
    return "wsl";
  }

  return process.platform;
}

function isAbsoluteExecutableCandidate(candidate) {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

export function getBrowserCandidates(
  family,
  env = process.env,
  platform = detectPlatform(env),
) {
  if (family === "firefox") {
    if (platform === "darwin") {
      return [
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        "firefox",
      ];
    }

    if (platform === "wsl") {
      return [
        "firefox",
        "/mnt/c/Program Files/Mozilla Firefox/firefox.exe",
        "firefox.exe",
      ];
    }

    if (platform === "win32") {
      return [
        "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "firefox.exe",
        "firefox",
      ];
    }

    return ["firefox"];
  }

  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "google-chrome",
      "chromium",
      "chromium-browser",
    ];
  }

  if (platform === "wsl") {
    return [
      "chromium-browser",
      "chromium",
      "google-chrome",
      "google-chrome-stable",
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      "/mnt/c/Program Files/Chromium/Application/chrome.exe",
      "google-chrome.exe",
      "chromium.exe",
    ];
  }

  if (platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "chrome.exe",
      "chromium.exe",
      "chromium-browser",
      "chromium",
      "google-chrome",
    ];
  }

  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
}

export async function findBrowserExecutable(family, env = process.env) {
  const candidates = getBrowserCandidates(family, env);
  const pathEntries = splitPathEntries(env.PATH);

  for (const candidate of candidates) {
    if (isAbsoluteExecutableCandidate(candidate)) {
      if (await isExecutable(candidate)) {
        return candidate;
      }
      continue;
    }

    for (const pathEntry of pathEntries) {
      const resolved = path.join(pathEntry, candidate);
      if (await isExecutable(resolved)) {
        return resolved;
      }
    }
  }

  return null;
}

export async function detectInstalledBrowsers(env = process.env) {
  const chromium = await findBrowserExecutable("chromium", env);
  const firefox = await findBrowserExecutable("firefox", env);

  return {
    chromium,
    firefox,
  };
}

export function buildBrowserLaunchArgs({
  family,
  url,
  remoteDebuggingPort,
  remoteDebuggingAddress,
  userDataDir,
}) {
  if (!url) {
    throw new Error("A target URL is required");
  }

  const args = [];
  if (family === "firefox") {
    if (remoteDebuggingPort) {
      args.push(`--remote-debugging-port=${remoteDebuggingPort}`);
    }
    args.push(url);
    return args;
  }

  if (remoteDebuggingAddress) {
    args.push(`--remote-debugging-address=${remoteDebuggingAddress}`);
  }
  if (remoteDebuggingPort) {
    args.push(`--remote-debugging-port=${remoteDebuggingPort}`);
  }
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  args.push(url);
  return args;
}
