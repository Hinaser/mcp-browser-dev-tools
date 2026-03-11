import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildBrowserLaunchArgs,
  findBrowserExecutable,
} from "./browser-launcher.mjs";
import { isLoopbackHost } from "./config.mjs";
import { collectDoctorReport } from "./doctor.mjs";

const FIREFOX_BIDI_SERVER_FILENAME = "WebDriverBiDiServer.json";
const execFileAsync = promisify(execFile);

function detectRuntimePlatform(env = process.env) {
  const release = os.release().toLowerCase();
  if (
    process.platform === "linux" &&
    (release.includes("microsoft") || env.WSL_INTEROP)
  ) {
    return "wsl";
  }

  return process.platform;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isHttpLikeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeFirefoxDoctorHost(value) {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }

  return host;
}

function normalizeFirefoxDoctorPath(value) {
  if (typeof value !== "string") {
    return "/";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeStringValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeIntegerValue(value, optionName, { minimum = 1 } = {}) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${optionName} must be an integer >= ${minimum}`);
  }

  return String(parsed);
}

function resolveDefaultPort(config, family) {
  if (family === "firefox") {
    return new URL(config.firefoxBidiWsUrl).port || "9222";
  }

  return new URL(config.cdpBaseUrl).port || "9222";
}

function resolveDefaultAddress(config) {
  const host = new URL(config.cdpBaseUrl).hostname;
  return host || "127.0.0.1";
}

function browserProcessMatchers(family) {
  if (family === "edge") {
    return [
      "msedge",
      "msedge.exe",
      "microsoft edge",
      "microsoft-edge",
      "microsoft-edge-stable",
    ];
  }

  if (family === "firefox") {
    return ["firefox", "firefox.exe"];
  }

  return [
    "chrome",
    "chrome.exe",
    "google chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium.exe",
    "chromium-browser",
  ];
}

function normalizeProcessEntry(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  const basename = lowered.split(/[\\/]/).pop();
  return basename || lowered;
}

function parsePsProcessList(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => normalizeProcessEntry(line))
    .filter(Boolean);
}

function parseTasklistProcessList(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^"([^"]+)"/);
      if (!match) {
        return null;
      }

      return normalizeProcessEntry(match[1]);
    })
    .filter(Boolean);
}

async function collectRunningProcesses(
  platform,
  { execFileFn = execFileAsync } = {},
) {
  const sources = [];
  const entries = [];
  const errors = [];

  const runSource = async (source, command, args, parser) => {
    try {
      const { stdout } = await execFileFn(command, args, {
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });
      sources.push(source);
      entries.push(...parser(stdout));
    } catch (error) {
      errors.push(`${source}: ${error?.message ?? String(error)}`);
    }
  };

  if (platform === "win32") {
    await runSource(
      "tasklist",
      "tasklist.exe",
      ["/fo", "csv", "/nh"],
      parseTasklistProcessList,
    );
  } else {
    await runSource("ps", "ps", ["-A", "-o", "comm="], parsePsProcessList);
    if (platform === "wsl") {
      await runSource(
        "tasklist",
        "tasklist.exe",
        ["/fo", "csv", "/nh"],
        parseTasklistProcessList,
      );
    }
  }

  return {
    checked: sources.length > 0,
    sources,
    entries: [...new Set(entries)],
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

async function detectRunningBrowserProcess(
  family,
  { env = process.env, execFileFn = execFileAsync } = {},
) {
  const platform = detectRuntimePlatform(env);
  const processList = await collectRunningProcesses(platform, { execFileFn });
  const matchers = browserProcessMatchers(family);
  const matches = processList.entries.filter((entry) =>
    matchers.includes(entry),
  );

  return {
    checked: processList.checked,
    detected: matches.length > 0,
    matches,
    sources: processList.sources,
    error: processList.error,
  };
}

async function maybeCreateAutomaticUserDataDir(
  family,
  normalizedUserDataDir,
  {
    env = process.env,
    execFileFn = execFileAsync,
    mkdtempFn = mkdtemp,
    tmpdirFn = os.tmpdir,
  } = {},
) {
  const existingBrowserProcess = await detectRunningBrowserProcess(family, {
    env,
    execFileFn,
  });

  if (
    (family === "chromium" || family === "edge") &&
    !normalizedUserDataDir &&
    existingBrowserProcess.detected
  ) {
    return {
      userDataDir: await mkdtempFn(
        path.join(tmpdirFn(), `mcp-browser-dev-tools-${family}-`),
      ),
      profileStrategy: "temporary",
      existingBrowserProcess,
    };
  }

  return {
    userDataDir: normalizedUserDataDir,
    profileStrategy: normalizedUserDataDir ? "provided" : "default",
    existingBrowserProcess,
  };
}

export function supportedLaunchFamilies(configuredFamily) {
  if (configuredFamily === "auto") {
    return ["chromium", "edge", "firefox"];
  }

  if (configuredFamily === "firefox") {
    return ["firefox"];
  }

  return ["chromium", "edge"];
}

export function resolveLaunchFamily(configuredFamily, requestedFamily) {
  const allowedFamilies = supportedLaunchFamilies(configuredFamily);
  if (!requestedFamily) {
    if (configuredFamily === "auto") {
      throw new Error(
        "browserFamily is required when multiple browser families are configured",
      );
    }

    return configuredFamily;
  }

  if (!allowedFamilies.includes(requestedFamily)) {
    throw new Error(
      `browserFamily must be one of: ${allowedFamilies.join(", ")}`,
    );
  }

  return requestedFamily;
}

export function parseFirefoxBidiServerInfo(contents) {
  const parsed = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const directUrl =
    parsed.webSocketUrl ??
    parsed.websocketUrl ??
    parsed.wsUrl ??
    parsed.ws_url ??
    null;
  if (typeof directUrl === "string" && directUrl.trim()) {
    return directUrl.trim().replace(/\/+$/, "");
  }

  const port =
    parsed.ws_port ?? parsed.port ?? parsed.remoteDebuggingPort ?? null;
  if (!Number.isInteger(port) && !/^\d+$/.test(String(port ?? "").trim())) {
    return null;
  }

  const host = normalizeFirefoxDoctorHost(
    parsed.ws_host ?? parsed.host ?? parsed.hostname ?? "127.0.0.1",
  );
  const protocol =
    parsed.protocol === "https" || parsed.protocol === "wss" ? "wss:" : "ws:";
  const endpoint = new URL(`${protocol}//${host}`);
  endpoint.port = String(port);
  endpoint.pathname = normalizeFirefoxDoctorPath(
    parsed.path ?? parsed.ws_path ?? "/",
  );
  return endpoint.toString().replace(/\/+$/, "");
}

export async function resolveFirefoxDoctorEndpoint(
  { userDataDir, fallbackPort },
  { readFileFn = readFile } = {},
) {
  if (!userDataDir) {
    return `ws://127.0.0.1:${fallbackPort}`;
  }

  try {
    const serverInfo = await readFileFn(
      path.join(userDataDir, FIREFOX_BIDI_SERVER_FILENAME),
      "utf8",
    );
    return (
      parseFirefoxBidiServerInfo(serverInfo) ?? `ws://127.0.0.1:${fallbackPort}`
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return `ws://127.0.0.1:${fallbackPort}`;
    }

    return `ws://127.0.0.1:${fallbackPort}`;
  }
}

export async function launchBrowser(
  {
    config,
    browserFamily,
    url = "about:blank",
    port,
    address,
    userDataDir,
    waitMs = 5_000,
    skipDoctor = false,
    env = process.env,
  },
  {
    spawnProcess = spawn,
    mkdirFn = mkdir,
    mkdtempFn = mkdtemp,
    execFileFn = execFileAsync,
    tmpdirFn = os.tmpdir,
    findBrowserExecutableFn = findBrowserExecutable,
    collectDoctorReportFn = collectDoctorReport,
    resolveFirefoxDoctorEndpointFn = resolveFirefoxDoctorEndpoint,
    sleepFn = sleep,
  } = {},
) {
  const family = resolveLaunchFamily(config.browserFamily, browserFamily);
  const targetUrl = normalizeStringValue(url) ?? "about:blank";
  const resolvedPort =
    normalizeIntegerValue(port, "port", { minimum: 1 }) ??
    resolveDefaultPort(config, family);
  const requestedAddress =
    family === "firefox" ? null : normalizeStringValue(address);

  if (
    requestedAddress &&
    !isLoopbackHost(requestedAddress) &&
    !config.allowRemoteEndpoints
  ) {
    throw new Error(
      "--address must be loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1",
    );
  }

  const executable = await findBrowserExecutableFn(family, env);
  if (!executable) {
    throw new Error(`No local ${family} browser executable found`);
  }

  const providedUserDataDir = normalizeStringValue(userDataDir) ?? undefined;
  const {
    userDataDir: normalizedUserDataDir,
    profileStrategy,
    existingBrowserProcess,
  } = await maybeCreateAutomaticUserDataDir(family, providedUserDataDir, {
    env,
    execFileFn,
    mkdtempFn,
    tmpdirFn,
  });
  if (family === "firefox" && normalizedUserDataDir) {
    await mkdirFn(normalizedUserDataDir, { recursive: true });
  }

  const launchAddress = family === "firefox" ? null : requestedAddress;
  const endpointAddress =
    family === "firefox"
      ? null
      : (requestedAddress ?? resolveDefaultAddress(config));
  const args = buildBrowserLaunchArgs({
    family,
    url: targetUrl,
    remoteDebuggingPort: resolvedPort,
    remoteDebuggingAddress: launchAddress ?? undefined,
    userDataDir: normalizedUserDataDir,
  });

  const child = spawnProcess(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();

  const launchedAt = new Date().toISOString();
  const result = {
    browserFamily: family,
    url: targetUrl,
    executable,
    args,
    pid: child.pid ?? null,
    launchedAt,
    endpoint:
      family === "firefox"
        ? `ws://127.0.0.1:${resolvedPort}`
        : `http://${endpointAddress}:${resolvedPort}`,
    userDataDir: normalizedUserDataDir ?? null,
    profileStrategy,
    existingBrowserProcess,
    doctorReport: null,
  };

  if (skipDoctor) {
    return result;
  }

  const timeoutMs =
    Number.parseInt(
      normalizeIntegerValue(waitMs, "waitMs", { minimum: 0 }) ?? "5000",
      10,
    ) || 0;
  const startedAt = Date.now();
  const doctorEnv = {
    ...env,
    MCP_BROWSER_FAMILY: family,
  };

  if (family === "firefox") {
    doctorEnv.FIREFOX_BIDI_WS_URL = await resolveFirefoxDoctorEndpointFn({
      userDataDir: normalizedUserDataDir,
      fallbackPort: resolvedPort,
    });
  } else {
    doctorEnv.CDP_BASE_URL = result.endpoint;
  }

  let report = await collectDoctorReportFn({
    env: doctorEnv,
    url: isHttpLikeUrl(targetUrl) ? targetUrl : null,
  });

  while (
    !report.browserStatus.available &&
    Date.now() - startedAt < timeoutMs
  ) {
    await sleepFn(250);
    if (family === "firefox") {
      doctorEnv.FIREFOX_BIDI_WS_URL = await resolveFirefoxDoctorEndpointFn({
        userDataDir: normalizedUserDataDir,
        fallbackPort: resolvedPort,
      });
    }

    report = await collectDoctorReportFn({
      env: doctorEnv,
      url: isHttpLikeUrl(targetUrl) ? targetUrl : null,
    });
  }

  result.endpoint =
    family === "firefox"
      ? doctorEnv.FIREFOX_BIDI_WS_URL
      : doctorEnv.CDP_BASE_URL;
  result.doctorReport = report;
  return result;
}
