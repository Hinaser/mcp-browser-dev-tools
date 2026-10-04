import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// upload_file hands local files to a web page, so it reads only from the
// directories the user would expect: the server's working directory
// (usually the project), the system temp directory, and those listed in
// MCP_BROWSER_UPLOAD_DIRS. Paths are compared after resolving symlinks, so
// a link inside an allowed directory cannot reach outside it. The boundary
// is against an agent a page has talked into uploading private files; it
// does not stop a process that can write to the allowed directories (it
// could swap a file for a link after the check), since such a process can
// read those files itself.
export async function allowedUploadDirs(config) {
  const dirs = [process.cwd(), tmpdir(), ...(config.uploadDirs ?? [])];
  const resolved = await Promise.all(
    dirs.map((dir) => realpath(dir).catch(() => null)),
  );
  return Array.from(new Set(resolved.filter(Boolean)));
}

function inside(dir, file) {
  const relative = path.relative(dir, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// The real paths of the files to upload; throws for a path that is not
// absolute, not a regular file, or outside the allowed directories.
export async function resolveUploadPaths(paths, allowedDirs) {
  const resolved = [];
  for (const file of paths) {
    if (!path.isAbsolute(file)) {
      throw new Error(`Upload path must be absolute: ${file}`);
    }
    let real;
    try {
      real = await realpath(file);
    } catch {
      throw new Error(`No file at ${file}`);
    }
    if (!(await stat(real)).isFile()) {
      throw new Error(`Not a regular file: ${file}`);
    }
    if (!allowedDirs.some((dir) => inside(dir, real))) {
      throw new Error(
        `${file} is outside the directories upload_file may read (the server's working directory, the temp directory, and MCP_BROWSER_UPLOAD_DIRS): ${allowedDirs.join(", ")}`,
      );
    }
    resolved.push(real);
  }
  return resolved;
}
