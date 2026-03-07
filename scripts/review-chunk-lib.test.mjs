import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";

import {
  cleanupTempFile,
  DEFAULT_TIMEOUT_MS,
  finalizeReport,
  parseTimeoutMs,
  slugify,
} from "./review-chunk-lib.mjs";

test("parseTimeoutMs falls back on invalid values", () => {
  assert.equal(parseTimeoutMs(undefined, 1234), 1234);
  assert.equal(parseTimeoutMs("", 1234), 1234);
  assert.equal(parseTimeoutMs("abc", 1234), 1234);
  assert.equal(parseTimeoutMs("0", 1234), 1234);
  assert.equal(parseTimeoutMs("-5", 1234), 1234);
  assert.equal(parseTimeoutMs("5000ms", 1234), 1234);
  assert.equal(parseTimeoutMs("5000", 1234), 5000);
  assert.equal(parseTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
});

test("slugify normalizes chunk titles", () => {
  assert.equal(slugify("  Review Scaffold  "), "review-scaffold");
  assert.equal(slugify("!!!"), "review");
});

test("finalizeReport renames a non-empty temp report", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "review-chunk-"));
  const tempFile = path.join(tempDir, "report.md.tmp");
  const outputFile = path.join(tempDir, "report.md");

  await writeFile(tempFile, "finding\n");
  await finalizeReport(tempFile, outputFile);

  const contents = await readFile(outputFile, "utf8");
  assert.equal(contents, "finding\n");
});

test("finalizeReport rejects empty reports and removes the temp file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "review-chunk-"));
  const tempFile = path.join(tempDir, "report.md.tmp");
  const outputFile = path.join(tempDir, "report.md");

  await writeFile(tempFile, "   \n");
  await assert.rejects(finalizeReport(tempFile, outputFile), {
    message: "review completed without a final report",
  });
  await assert.rejects(stat(tempFile));
});

test("cleanupTempFile tolerates missing files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "review-chunk-"));
  const missingFile = path.join(tempDir, "missing.tmp");

  await cleanupTempFile(missingFile);
  await assert.rejects(stat(missingFile));
});
