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

  function installSignalHandlers() {
    process.on("SIGINT", () => {
      void close("SIGINT").finally(() => process.exit(0));
    });

    process.on("SIGTERM", () => {
      void close("SIGTERM").finally(() => process.exit(0));
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
