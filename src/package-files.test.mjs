import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// npm publishes only the files package.json lists, so a runtime module left
// out of it breaks the installed server.
test("package.json lists every runtime module under src", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const entries = await readdir(new URL(".", import.meta.url), {
    recursive: true,
  });
  const runtime = entries
    .map((entry) => `src/${entry.split(path.sep).join("/")}`)
    .filter(
      (file) =>
        file.endsWith(".mjs") &&
        !file.endsWith(".test.mjs") &&
        file !== "src/mcp-test-support.mjs",
    );
  const missing = runtime.filter((file) => !pkg.files.includes(file));
  assert.deepEqual(missing, []);
});
