import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

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
