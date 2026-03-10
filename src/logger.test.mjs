import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "./logger.mjs";

function createBufferOutput() {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    },
    read() {
      return output;
    },
  };
}

test("createLogger filters messages below the configured level", () => {
  const output = createBufferOutput();
  const logger = createLogger({
    level: "warn",
    output: output.stream,
    name: "test-logger",
  });

  logger.info("hidden");
  logger.warn("shown");

  assert.equal(output.read().includes("hidden"), false);
  assert.match(output.read(), /\[test-logger\] warn: shown/);
});

test("createLogger can force a message regardless of level", () => {
  const output = createBufferOutput();
  const logger = createLogger({
    level: "error",
    output: output.stream,
    name: "test-logger",
  });

  logger.log("debug", "forced", { force: true });

  assert.match(output.read(), /\[test-logger\] debug: forced/);
});
