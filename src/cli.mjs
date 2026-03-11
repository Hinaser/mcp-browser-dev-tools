#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createBrowserDevToolsApp } from "./app.mjs";
import { loadConfig, loadLoggingConfig } from "./config.mjs";
import { collectDoctorReport, renderDoctorReport } from "./doctor.mjs";
import { createLogger } from "./logger.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";
import { bootstrapWslRelay } from "./serve-bootstrap.mjs";
import { resolveRelayOptions, startTcpRelay } from "./tcp-relay.mjs";
import { launchBrowser } from "./browser-launch-service.mjs";

export {
  parseFirefoxBidiServerInfo,
  resolveFirefoxDoctorEndpoint,
} from "./browser-launch-service.mjs";

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
      "Serve options:",
      "  --bootstrap-wsl-relay  in WSL, start a Windows-side CDP relay and point the broker at it",
      "  --bridge-port <port>   relay port exposed back to WSL (defaults to the CDP target port)",
      "  --target-port <port>   Windows browser CDP target port for the relay",
      "",
      "Open options:",
      "  --family <name>      chromium, edge, or firefox",
      "  --port <port>        remote debugging port",
      "  --address <host>     remote debugging address for Chromium",
      "  --user-data-dir <p>  optional Chromium user data dir or Firefox profile dir",
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

async function runServe(options = {}) {
  let relayBootstrap = null;

  try {
    let env = process.env;
    if (options["bootstrap-wsl-relay"] === true) {
      const config = loadConfig(env);
      relayBootstrap = await bootstrapWslRelay({
        config,
        relayListenPort: options["bridge-port"],
        relayTargetPort: options["target-port"],
        env,
      });
      env = relayBootstrap.env;
      process.stderr.write(
        `bootstrapped WSL relay: ${relayBootstrap.bridge.cdpBaseUrl} -> 127.0.0.1:${relayBootstrap.bridge.targetPort}\n`,
      );
    }

    const app = createBrowserDevToolsApp({
      env,
      extraCloseHandlers: relayBootstrap
        ? [() => relayBootstrap.close()]
        : undefined,
    });
    app.installSignalHandlers();
    app.start();
  } catch (error) {
    await relayBootstrap?.close().catch(() => {});
    throw error;
  }
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
  const launch = await launchBrowser({
    config,
    browserFamily: typeof options.family === "string" ? options.family : null,
    url,
    port: options.port,
    address: options.address,
    userDataDir: options["user-data-dir"],
    waitMs: options["wait-ms"],
    skipDoctor: options["no-doctor"] === true,
  });

  process.stdout.write(
    `launched ${launch.browserFamily} browser: ${launch.executable} ${launch.args.join(" ")}\n`,
  );

  if (launch.profileStrategy === "temporary" && launch.userDataDir) {
    process.stdout.write(
      `using temporary browser profile: ${launch.userDataDir}\n`,
    );
  }

  if (!launch.doctorReport) {
    return;
  }

  process.stdout.write(`${renderDoctorReport(launch.doctorReport)}\n`);

  if (!launch.doctorReport.browserStatus.available) {
    process.exitCode = 1;
  }
}

async function runRelay(options) {
  const logging = loadLoggingConfig(process.env);
  const logger = createLogger({
    level: logging.logLevel,
    output: process.stderr,
    name: PACKAGE_NAME,
  });
  const relayOptions = resolveRelayOptions(options);
  const relay = await startTcpRelay({
    ...relayOptions,
    logger,
  });

  const close = async (signal) => {
    logger.info(`relay shutting down after ${signal}`);
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
      await runServe(options);
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
