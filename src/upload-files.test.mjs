import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { allowedUploadDirs, resolveUploadPaths } from "./upload-files.mjs";

test("upload paths must be absolute files inside the allowed directories", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(path.join(allowed, "a.txt"), "a");
  await writeFile(path.join(allowed, "..notes.txt"), "n");
  await writeFile(path.join(outside, "secret.txt"), "s");
  await symlink(
    path.join(outside, "secret.txt"),
    path.join(allowed, "link.txt"),
  );
  const dirs = await allowedUploadDirs({ uploadDirs: [allowed] });
  const onlyAllowed = dirs.filter((dir) => dir.endsWith("allowed"));

  const [file] = await resolveUploadPaths(
    [path.join(allowed, "a.txt")],
    onlyAllowed,
  );
  assert.ok(file.endsWith(path.join("allowed", "a.txt")));

  // A name that only starts with two dots is still inside.
  const [dotted] = await resolveUploadPaths(
    [path.join(allowed, "..notes.txt")],
    onlyAllowed,
  );
  assert.ok(dotted.endsWith("..notes.txt"));

  for (const [paths, message] of [
    [["a.txt"], /must be absolute/],
    [[path.join(allowed, "missing.txt")], /No file at/],
    [[allowed], /Not a regular file/],
    [[path.join(outside, "secret.txt")], /outside the directories/],
    // A link inside an allowed directory cannot reach outside it.
    [[path.join(allowed, "link.txt")], /outside the directories/],
  ]) {
    await assert.rejects(resolveUploadPaths(paths, onlyAllowed), message);
  }
});

test("the working directory and the temp directory are allowed by default", async () => {
  const dirs = await allowedUploadDirs({});
  assert.equal(dirs.length >= 2, true);
});
