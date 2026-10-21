import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runScript(code) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--input-type=module", "-e", code],
      { timeout: 10_000 },
      (error, _stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stderr });
      },
    );
    child.stdin.end();
  });
}

test("uncaught exception is logged to stderr before exit", async () => {
  const { code, stderr } = await runScript(`
    import { createBrowserDevToolsApp } from "./src/app.mjs";
    const app = createBrowserDevToolsApp({
      input: new (await import("node:stream")).PassThrough(),
      output: new (await import("node:stream")).PassThrough(),
    });
    app.installSignalHandlers();
    setTimeout(() => { throw new Error("boom"); }, 10);
  `);

  assert.equal(code, 1);
  assert.match(stderr, /uncaught exception:.*boom/);
  assert.match(stderr, /process exiting with code 1/);
});

test("unhandled rejection is logged to stderr before exit", async () => {
  const { code, stderr } = await runScript(`
    import { createBrowserDevToolsApp } from "./src/app.mjs";
    const app = createBrowserDevToolsApp({
      input: new (await import("node:stream")).PassThrough(),
      output: new (await import("node:stream")).PassThrough(),
    });
    app.installSignalHandlers();
    setTimeout(() => { Promise.reject(new Error("async boom")); }, 10);
  `);

  assert.equal(code, 1);
  assert.match(stderr, /unhandled rejection:.*async boom/);
  assert.match(stderr, /process exiting with code 1/);
});

test("a signal during a fatal shutdown keeps cleanup and exit code 1", async () => {
  const { code, stderr } = await runScript(`
    import { createBrowserDevToolsApp } from "./src/app.mjs";
    const app = createBrowserDevToolsApp({
      input: new (await import("node:stream")).PassThrough(),
      output: new (await import("node:stream")).PassThrough(),
      extraCloseHandlers: [
        async () => {
          process.kill(process.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 100));
          process.stderr.write("cleanup finished\\n");
        },
      ],
    });
    app.installSignalHandlers();
    setTimeout(() => { throw new Error("boom"); }, 10);
  `);

  assert.equal(code, 1);
  assert.match(stderr, /cleanup finished/);
});

test("a closed stderr pipe shuts the server down instead of looping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mbdt-app-"));
  const logFile = join(dir, "server.log");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { createBrowserDevToolsApp } from "./src/app.mjs";
        const app = createBrowserDevToolsApp({
          input: new (await import("node:stream")).PassThrough(),
          output: new (await import("node:stream")).PassThrough(),
        });
        app.installSignalHandlers();
        setInterval(() => app.logger.info("tick"), 5);
      `,
    ],
    {
      env: {
        ...process.env,
        MCP_BROWSER_LOG_LEVEL: "info",
        MCP_BROWSER_LOG_FILE: logFile,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.once("data", () => child.stderr.destroy());

  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("server did not exit after stderr closed"));
      }, 10_000);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    assert.equal(code, 0);
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /stderr failed: EPIPE/);
    assert.doesNotMatch(log, /uncaught exception/);
    assert.ok(statSync(logFile).size < 64 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
