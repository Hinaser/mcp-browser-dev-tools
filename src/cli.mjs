#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createBrowserDevToolsApp } from "./app.mjs";
import {
  buildBrowserLaunchArgs,
  findBrowserExecutable,
} from "./browser-launcher.mjs";
import { loadConfig } from "./config.mjs";
import { collectDoctorReport, renderDoctorReport } from "./doctor.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";

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
      "",
    ].join("\n"),
  );
}

function printVersion() {
  process.stdout.write(`${PACKAGE_VERSION}\n`);
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
  if (!report.browserStatus.available || (report.targetUrl && !report.targetUrl.reachable)) {
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
  const executable = await findBrowserExecutable(family);
  if (!executable) {
    throw new Error(`No local ${family} browser executable found`);
  }

  const defaultPort =
    family === "firefox"
      ? new URL(config.firefoxBidiWsUrl).port || "9222"
      : new URL(config.cdpBaseUrl).port || "9222";

  const args = buildBrowserLaunchArgs({
    family,
    url,
    remoteDebuggingPort:
      typeof options.port === "string" ? options.port : defaultPort,
    remoteDebuggingAddress:
      family === "chromium" && typeof options.address === "string"
        ? options.address
        : undefined,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
