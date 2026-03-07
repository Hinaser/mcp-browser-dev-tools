import { readFile, rename, rm } from "node:fs/promises";

export const DEFAULT_TIMEOUT_MS = 300000;

export function formatStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "review";
}

export function parseTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(normalized)) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  return parsed > 0 ? parsed : fallback;
}

export async function cleanupTempFile(tempFile) {
  await rm(tempFile, { force: true });
}

export async function finalizeReport(tempFile, outputFile) {
  const report = await readFile(tempFile, "utf8").catch(() => {
    throw new Error(`review report missing at ${tempFile}`);
  });

  if (!report.trim()) {
    await cleanupTempFile(tempFile);
    throw new Error("review completed without a final report");
  }

  await rename(tempFile, outputFile);
}
