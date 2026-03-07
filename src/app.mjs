import { createBrowserAdapter } from "./browser-adapter.mjs";
import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { PACKAGE_NAME } from "./package-info.mjs";

export function createBrowserDevToolsApp({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  const config = loadConfig(env);
  const browserAdapter = createBrowserAdapter(config);
  const server = new McpBrowserDevToolsServer({
    config,
    browserAdapter,
    input,
    output,
    errorOutput,
  });

  let closing = false;

  async function close(signal = "shutdown") {
    if (closing) {
      return;
    }

    closing = true;
    errorOutput.write(`[${PACKAGE_NAME}] shutting down after ${signal}\n`);
    await browserAdapter.closeAll();
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
    browserAdapter,
    server,
    start,
    close,
    installSignalHandlers,
  };
}
