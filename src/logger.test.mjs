import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("createLogger writes to a log file when filePath is provided", () => {
  const logFile = join(tmpdir(), `mbdt-test-${Date.now()}.log`);
  const output = createBufferOutput();
  const logger = createLogger({
    level: "info",
    output: output.stream,
    name: "test-logger",
    filePath: logFile,
  });

  logger.info("file entry");

  try {
    const fileContent = readFileSync(logFile, "utf8");
    assert.match(fileContent, /\[test-logger\] info: file entry/);
    assert.match(output.read(), /\[test-logger\] info: file entry/);
  } finally {
    try {
      unlinkSync(logFile);
    } catch {
      // ignore cleanup errors
    }
  }
});

test("createLogger stops writing to an output whose write throws", () => {
  let writes = 0;
  const dir = mkdtempSync(join(tmpdir(), "mbdt-logger-"));
  const logFile = join(dir, "server.log");
  const logger = createLogger({
    level: "info",
    output: {
      write() {
        writes += 1;
        throw new Error("EPIPE: broken pipe, write");
      },
    },
    name: "test-logger",
    filePath: logFile,
  });

  try {
    logger.info("first");
    logger.info("second");

    assert.equal(writes, 1);
    assert.match(readFileSync(logFile, "utf8"), /first\n.*second/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLogger disableOutput keeps logging to the file only", () => {
  const output = createBufferOutput();
  const dir = mkdtempSync(join(tmpdir(), "mbdt-logger-"));
  const logFile = join(dir, "server.log");
  const logger = createLogger({
    level: "info",
    output: output.stream,
    name: "test-logger",
    filePath: logFile,
  });

  try {
    logger.disableOutput();
    logger.info("file only");

    assert.equal(output.read(), "");
    assert.match(readFileSync(logFile, "utf8"), /file only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLogger rotates the log file once it would pass maxFileBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbdt-logger-"));
  const logFile = join(dir, "server.log");
  const logger = createLogger({
    level: "info",
    output: createBufferOutput().stream,
    name: "t",
    filePath: logFile,
    maxFileBytes: 100,
  });

  try {
    for (let index = 0; index < 50; index += 1) {
      logger.info(`line ${index}`);
    }

    assert.ok(statSync(logFile).size <= 100);
    assert.ok(statSync(`${logFile}.1`).size <= 100);
    assert.match(readFileSync(logFile, "utf8"), /line 49\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLogger keeps a line longer than maxFileBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbdt-logger-"));
  const logFile = join(dir, "server.log");
  const logger = createLogger({
    level: "info",
    output: createBufferOutput().stream,
    name: "t",
    filePath: logFile,
    maxFileBytes: 10,
  });

  try {
    logger.info("longer than ten bytes");
    logger.info("next");

    assert.match(readFileSync(`${logFile}.1`, "utf8"), /longer than ten bytes/);
    assert.equal(readFileSync(logFile, "utf8"), "[t] info: next\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
