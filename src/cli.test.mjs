import test from "node:test";
import assert from "node:assert/strict";

import { parseCliArgs, runCli } from "./cli.mjs";
import { PACKAGE_VERSION } from "./package-info.mjs";

test("parseCliArgs defaults to serve", () => {
  assert.deepEqual(parseCliArgs([]), {
    command: "serve",
    positional: [],
    options: {},
  });
});

test("parseCliArgs parses positional arguments and flags", () => {
  assert.deepEqual(
    parseCliArgs([
      "open",
      "http://127.0.0.1:3000",
      "--family",
      "firefox",
      "--port=9222",
    ]),
    {
      command: "open",
      positional: ["http://127.0.0.1:3000"],
      options: {
        family: "firefox",
        port: "9222",
      },
    },
  );
});

test("runCli prints usage for top-level --help", async () => {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await runCli(["--help"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(output, /Usage: mcp-browser-dev-tools/);
});

test("runCli prints the package version for top-level --version", async () => {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await runCli(["--version"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(output.trim(), PACKAGE_VERSION);
});
