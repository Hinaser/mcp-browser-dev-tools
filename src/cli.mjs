#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createBrowserDevToolsApp } from "./app.mjs";
import {
  buildBrowserLaunchArgs,
  findBrowserExecutable,
} from "./browser-launcher.mjs";
import { isLoopbackHost, loadConfig } from "./config.mjs";
import { collectDoctorReport, renderDoctorReport } from "./doctor.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";
import { resolveRelayOptions, startTcpRelay } from "./tcp-relay.mjs";

export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "serve";
  const positional = [];
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }

    const nextValue = args[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      options[rawKey] = true;
      continue;
    }

    options[rawKey] = nextValue;
    index += 1;
  }

  return { command, positional, options };
}

function printUsage() {
  process.stdout.write(
    [
      `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
      "",
      `Usage: ${PACKAGE_NAME} <command> [options]`,
      "",
      "Commands:",
      "  serve                Run the MCP broker over stdio",
      "  doctor [--url URL]   Check browser endpoint and optional page reachability",
      "  open <url>           Launch a local browser with remote debugging enabled",
      "  relay                Forward TCP traffic across a local machine boundary",
      "  version              Print the package version",
      "  help                 Print usage information",
      "",
      "Global options:",
      "  --help               Print usage information",
      "  --version            Print the package version",
      "",
      "Open options:",
      "  --family <name>      chromium or firefox",
      "  --port <port>        remote debugging port",
      "  --address <host>     remote debugging address for Chromium",
      "  --user-data-dir <p>  optional browser profile directory",
      "  --wait-ms <ms>       wait for the debug endpoint and print doctor output",
      "  --no-doctor          skip the post-launch doctor check",
      "",
      "Relay options:",
      "  --listen-host <host> relay bind host (defaults to 127.0.0.1)",
      "  --listen-port <port> relay bind port (defaults to 9223)",
      "  --target-host <host> relay target host (defaults to 127.0.0.1)",
      "  --target-port <port> relay target port (defaults to 9222)",
      "  --wsl                on Windows, bind to the WSL virtual interface",
      "",
    ].join("\n"),
  );
}

function printVersion() {
  process.stdout.write(`${PACKAGE_VERSION}\n`);
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

async function runServe() {
  const app = createBrowserDevToolsApp();
  app.installSignalHandlers();
  app.start();
}

async function runDoctor(options) {
  const report = await collectDoctorReport({
    url: typeof options.url === "string" ? options.url : null,
  });
  process.stdout.write(`${renderDoctorReport(report)}\n`);
  if (
    !report.browserStatus.available ||
    (report.targetUrl && !report.targetUrl.reachable)
  ) {
    process.exitCode = 1;
  }
}

async function runOpen(positional, options) {
  const url = positional[0];
  if (!url) {
    throw new Error("open requires a URL");
  }

  const config = loadConfig();
  const family =
    typeof options.family === "string" ? options.family : config.browserFamily;
  const requestedAddress =
    family === "chromium" && typeof options.address === "string"
      ? options.address.trim()
      : null;

  if (
    requestedAddress &&
    !isLoopbackHost(requestedAddress) &&
    !config.allowRemoteEndpoints
  ) {
    throw new Error(
      "--address must be loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1",
    );
  }

  const executable = await findBrowserExecutable(family);
  if (!executable) {
    throw new Error(`No local ${family} browser executable found`);
  }

  const defaultPort =
    family === "firefox"
      ? new URL(config.firefoxBidiWsUrl).port || "9222"
      : new URL(config.cdpBaseUrl).port || "9222";
  const resolvedPort =
    typeof options.port === "string" ? options.port : defaultPort;

  const args = buildBrowserLaunchArgs({
    family,
    url,
    remoteDebuggingPort: resolvedPort,
    remoteDebuggingAddress: requestedAddress || undefined,
    userDataDir:
      family === "chromium" && typeof options["user-data-dir"] === "string"
        ? options["user-data-dir"]
        : undefined,
  });

  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  process.stdout.write(
    `launched ${family} browser: ${executable} ${args.join(" ")}\n`,
  );

  if (options["no-doctor"] === true) {
    return;
  }

  const waitMs =
    typeof options["wait-ms"] === "string"
      ? Number.parseInt(options["wait-ms"], 10)
      : 5000;
  const timeoutMs = Number.isInteger(waitMs) && waitMs >= 0 ? waitMs : 5000;
  const startedAt = Date.now();
  const doctorEnv = {
    ...process.env,
    MCP_BROWSER_FAMILY: family,
  };

  if (family === "firefox") {
    doctorEnv.FIREFOX_BIDI_WS_URL = `ws://127.0.0.1:${resolvedPort}`;
  } else {
    const address = requestedAddress || "127.0.0.1";
    doctorEnv.CDP_BASE_URL = `http://${address}:${resolvedPort}`;
  }

  let report = await collectDoctorReport({
    env: doctorEnv,
    url: isHttpLikeUrl(url) ? url : null,
  });

  while (
    !report.browserStatus.available &&
    Date.now() - startedAt < timeoutMs
  ) {
    await sleep(250);
    report = await collectDoctorReport({
      env: doctorEnv,
      url: isHttpLikeUrl(url) ? url : null,
    });
  }

  process.stdout.write(`${renderDoctorReport(report)}\n`);

  if (!report.browserStatus.available) {
    process.exitCode = 1;
  }
}

async function runRelay(options) {
  const relayOptions = resolveRelayOptions(options);
  const relay = await startTcpRelay(relayOptions);

  const close = async (signal) => {
    process.stderr.write(`[relay] shutting down after ${signal}\n`);
    await relay.close();
  };

  process.on("SIGINT", () => {
    void close("SIGINT").finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void close("SIGTERM").finally(() => process.exit(0));
  });

  process.stdout.write(
    `relay listening on ${relayOptions.listenHost}:${relayOptions.listenPort} -> ${relayOptions.targetHost}:${relayOptions.targetPort}\n`,
  );

  if (relayOptions.useWslBridge) {
    process.stdout.write(
      `for WSL use: CDP_BASE_URL=http://${relayOptions.listenHost}:${relayOptions.listenPort}\n`,
    );
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, positional, options } = parseCliArgs(argv);

  if (options.version === true) {
    printVersion();
    return;
  }

  if (options.help === true) {
    printUsage();
    return;
  }

  switch (command) {
    case "serve":
      await runServe();
      return;
    case "doctor":
      await runDoctor(options);
      return;
    case "open":
      await runOpen(positional, options);
      return;
    case "relay":
      await runRelay(options);
      return;
    case "version":
    case "-v":
      printVersion();
      return;
    case "help":
    case "-h":
      printUsage();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
