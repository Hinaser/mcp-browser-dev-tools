import { createBrowserAdapter } from "./browser-adapter.mjs";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { PACKAGE_NAME } from "./package-info.mjs";

export function createBrowserDevToolsApp({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  extraCloseHandlers = [],
} = {}) {
  const config = loadConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    output: errorOutput,
    name: PACKAGE_NAME,
    filePath: config.logFile,
  });
  const browserAdapter = createBrowserAdapter(config);
  const server = new McpBrowserDevToolsServer({
    config,
    browserAdapter,
    input,
    output,
    errorOutput,
    logger,
  });

  let closing = false;

  async function close(signal = "shutdown") {
    if (closing) {
      return;
    }

    closing = true;
    logger.info(`shutting down after ${signal}`);
    let firstError = null;

    try {
      await browserAdapter.closeAll();
    } catch (error) {
      firstError = error;
    }

    for (const handler of extraCloseHandlers) {
      try {
        await handler(signal);
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
      }
    }

    if (firstError) {
      throw firstError;
    }
  }

  function start() {
    server.start();
  }

  let exitCode = null;

  // Closes once and exits with the highest code asked for meanwhile.
  function closeAndExit(signal, code) {
    const first = exitCode == null;
    exitCode = Math.max(exitCode ?? 0, code);
    if (first) {
      void close(signal).finally(() => process.exit(exitCode));
    }
  }

  let fatal = false;

  function handleFatal(signal, message) {
    // Only the first one is logged: a fatal error raised by the logging
    // itself would otherwise come back here forever.
    if (fatal) {
      return;
    }

    fatal = true;
    logger.error(message, { force: true });
    closeAndExit(signal, 1);
  }

  function handleStreamError(name, stream, error) {
    if (stream === errorOutput) {
      logger.disableOutput();
    }
    logger.info(`${name} failed: ${error?.code ?? error?.message ?? error}`);
    // EPIPE means the client closed its end, and without stdout the server
    // cannot answer it anyway.
    if (stream === output || error?.code === "EPIPE") {
      closeAndExit(`${name} error`, 0);
    }
  }

  function installSignalHandlers() {
    process.on("SIGINT", () => {
      closeAndExit("SIGINT", 0);
    });

    process.on("SIGTERM", () => {
      closeAndExit("SIGTERM", 0);
    });

    // Without a listener, a failed write to a closed pipe becomes an
    // uncaught exception.
    output.on?.("error", (error) => handleStreamError("stdout", output, error));
    errorOutput.on?.("error", (error) =>
      handleStreamError("stderr", errorOutput, error),
    );

    process.on("uncaughtException", (error) => {
      handleFatal(
        "uncaughtException",
        `uncaught exception: ${error?.stack ?? error}`,
      );
    });

    process.on("unhandledRejection", (reason) => {
      handleFatal(
        "unhandledRejection",
        `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`,
      );
    });

    process.on("exit", (code) => {
      if (code !== 0) {
        logger.error(`process exiting with code ${code}`, { force: true });
      }
    });
  }

  return {
    config,
    logger,
    browserAdapter,
    server,
    start,
    close,
    installSignalHandlers,
  };
}
