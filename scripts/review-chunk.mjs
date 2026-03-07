import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  cleanupTempFile,
  DEFAULT_TIMEOUT_MS,
  finalizeReport,
  formatStamp,
  parseTimeoutMs,
  slugify,
} from "./review-chunk-lib.mjs";

async function main() {
  const title = process.argv.slice(2).join(" ").trim() || "chunk-review";
  const reviewsDir = path.resolve(".codex-reviews");
  const outputFile = path.join(
    reviewsDir,
    `${formatStamp(new Date())}-${slugify(title)}.md`,
  );
  const tempFile = `${outputFile}.tmp`;
  const timeoutMs = parseTimeoutMs(
    process.env.CODEX_REVIEW_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );

  await mkdir(reviewsDir, { recursive: true });
  await cleanupTempFile(tempFile);

  const prompt = [
    "Review the current repository working tree.",
    "Inspect files directly and do not rely only on git diff, because the repo may contain untracked files.",
    "Do not invoke nested review helpers, `codex exec`, or other nested Codex processes.",
    "Prioritize correctness, security, behavior regressions, and missing tests.",
    "Return findings first with file references, then open questions, then a short summary.",
  ].join(" ");

  const args = ["exec", "--ephemeral", "-o", tempFile];

  const reviewModel = process.env.CODEX_REVIEW_MODEL?.trim();
  if (reviewModel) {
    args.push("-m", reviewModel);
  }

  args.push(prompt);

  const child = spawn("codex", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, timeoutMs);
  timeout.unref();

  child.on("error", (error) => {
    clearTimeout(timeout);
    void cleanupTempFile(tempFile);
    process.exitCode = 1;
    console.error(`review launch failed: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    void (async () => {
      clearTimeout(timeout);

      if (didTimeout) {
        await cleanupTempFile(tempFile);
        process.exitCode = 1;
        console.error(`review timed out after ${timeoutMs}ms`);
        return;
      }

      if (signal) {
        await cleanupTempFile(tempFile);
        process.exitCode = 1;
        console.error(`review interrupted by signal: ${signal}`);
        return;
      }

      if (code !== 0) {
        await cleanupTempFile(tempFile);
        process.exitCode = code ?? 1;
        console.error(`review failed with exit code ${code ?? "unknown"}`);
        return;
      }

      await finalizeReport(tempFile, outputFile);
      console.log(`review saved to ${outputFile}`);
    })().catch(async (error) => {
      await cleanupTempFile(tempFile);
      process.exitCode = 1;
      console.error(`review finalization failed: ${error.message}`);
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
