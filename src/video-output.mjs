import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  constants,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { SCREENSHOT_FILE_MODE } from "./screenshot-output.mjs";

// How long an encode may run before it is given up and the frames kept.
const ENCODE_TIMEOUT_MS = 10 * 60_000;
const STDERR_KEEP = 4096;

// Each frame lasts until the next one, and the last until the capture
// stopped, so a page that repaints rarely plays at its real pace. A frame
// that is not later than the one before it (a duplicate timestamp, or one
// delivered out of order) is left out, so every duration is positive. The
// last frame is listed again half a frame before the end: ffmpeg ends a
// stream one estimated interval after its last frame, and drops a frame at
// or past -t, so the copy holds the picture while -t sets the length.
export function frameDurations(frames, stoppedAt, fps) {
  const kept = [];
  for (const frame of frames) {
    if (kept.length === 0 || frame.timestamp > kept.at(-1).timestamp) {
      kept.push(frame);
    }
  }
  return kept.map((frame, index) => {
    const next = kept[index + 1];
    const until = next ? next.timestamp : stoppedAt - 0.5 / fps;
    return {
      file: frame.file,
      duration: Math.max(
        0.001,
        Math.round((until - frame.timestamp) * 1000) / 1000,
      ),
    };
  });
}

// The concat demuxer's script. File names are relative to the script, so
// no path needs quoting. Each JPEG is read with a 1 ms timebase (the
// default, 1/25 s, would round every frame time to 40 ms), which needs
// -safe 0; the script and the frames are in the recording's own directory.
export function concatList(entries) {
  const lines = ["ffconcat version 1.0"];
  for (const entry of entries) {
    lines.push(
      `file ${entry.file}`,
      "option framerate 1000",
      `duration ${entry.duration.toFixed(3)}`,
    );
  }
  if (entries.length > 0) {
    lines.push(`file ${entries.at(-1).file}`, "option framerate 1000");
  }
  return `${lines.join("\n")}\n`;
}

export function evenSize(size) {
  return {
    width: Math.max(2, Math.floor(size.width / 2) * 2),
    height: Math.max(2, Math.floor(size.height / 2) * 2),
  };
}

// H.264 at a constant frame rate for exactly the capture's length, scaled
// to the recording's even size and to limited-range yuv420p (JPEG frames
// are full range) so players and browsers open it, with the index first.
export function ffmpegArgs({
  listPath,
  fps,
  width,
  height,
  durationS,
  outputPath,
}) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-safe",
    "0",
    "-f",
    "concat",
    "-i",
    listPath,
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    "-vf",
    `scale=${width}:${height}:in_range=full:out_range=limited,setsar=1,format=yuv420p`,
    "-t",
    durationS.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function shellQuote(value) {
  return /^[\w./:=+@%,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

async function isExecutable(file) {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

// MCP_BROWSER_FFMPEG, else the first ffmpeg on PATH, else null.
export async function findFfmpeg(config = {}, env = process.env) {
  if (config.ffmpegPath) {
    return (await isExecutable(config.ffmpegPath)) ? config.ffmpegPath : null;
  }
  const names =
    process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

const encoders = new Set();
let exitHookInstalled = false;

// An encoder still running when the server exits is killed with it.
function trackEncoder(child) {
  encoders.add(child);
  child.once("exit", () => encoders.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const encoder of encoders) {
        encoder.kill("SIGKILL");
      }
    });
  }
}

export function runFfmpeg(command, args, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawnFn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    trackEncoder(child);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\nffmpeg was stopped after ${ENCODE_TIMEOUT_MS / 60_000} minutes`;
    }, ENCODE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: `ffmpeg exited with ${signal ?? code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        });
      }
    });
  });
}

// Checked before the capture stops, so a bad path does not cost the frames.
export async function checkVideoPath(args) {
  if (args.path === undefined) {
    return;
  }
  if (!path.isAbsolute(args.path) || !args.path.endsWith(".mp4")) {
    throw new Error("record_video path must be absolute and end in .mp4");
  }
  if (!args.overwrite) {
    const exists = await lstat(args.path).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new Error(
        `${args.path} already exists; pass overwrite: true to replace it`,
      );
    }
  }
}

// Moves the encoded file, private already, into place like a screenshot:
// never over an existing file unless asked, and never through a symlink
// (link and rename replace a link at the path rather than following it).
// Across volumes the file is copied into one opened exclusively instead.
async function placeVideo(encoded, filePath, overwrite) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    if (overwrite) {
      await rename(encoded, filePath);
    } else {
      await link(encoded, filePath);
      await unlink(encoded);
    }
    return;
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `${filePath} already exists; pass overwrite: true to replace it`,
        { cause: error },
      );
    }
    // Another volume, or a filesystem without hard links: copy instead.
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
      throw error;
    }
  }
  const target = overwrite ? `${filePath}.${randomUUID()}.tmp` : filePath;
  let handle;
  try {
    handle = await open(target, "wx", SCREENSHOT_FILE_MODE);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `${filePath} already exists; pass overwrite: true to replace it`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await pipeline(createReadStream(encoded), handle.createWriteStream());
    if (overwrite) {
      await rename(target, filePath);
    }
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  await unlink(encoded);
}

// Both sides are resolved through symlinks (the destination by its nearest
// existing ancestor), so an alias such as /private/var for /var is caught.
async function isInside(dir, filePath) {
  const realDir = await realpath(dir);
  let ancestor = path.resolve(filePath);
  let rest = "";
  while (true) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch {
      rest = path.join(path.basename(ancestor), rest);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
  }
  const relative = path.relative(realDir, path.join(ancestor, rest));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function tempVideoPath() {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-browser-dev-tools-"));
  return path.join(dir, "video.mp4");
}

// Encodes a capture ({ dir, frames, startedAt, stoppedAt, fps, width,
// height, warnings }) to MP4. Without ffmpeg, or when it fails, the frames
// stay in their directory and the result says so and gives the command.
export async function encodeVideo(capture, args, config, { spawnFn } = {}) {
  const entries = frameDurations(
    capture.frames,
    capture.stoppedAt,
    capture.fps,
  );
  const { width, height } = evenSize(capture);
  const listPath = path.join(capture.dir, "frames.ffconcat");
  await writeFile(listPath, concatList(entries), {
    mode: SCREENSHOT_FILE_MODE,
  });
  const encoded = path.join(capture.dir, "video.mp4");
  const durationS = Math.max(0, capture.stoppedAt - capture.startedAt);
  const ffmpegArguments = ffmpegArgs({
    listPath,
    fps: capture.fps,
    width,
    height,
    durationS,
    outputPath: encoded,
  });
  const summary = {
    durationMs: Math.round(durationS * 1000),
    frames: entries.length,
    width,
    height,
    ...(capture.warnings?.length ? { warnings: capture.warnings } : {}),
  };
  const kept = (error) => ({
    ...summary,
    framesDir: capture.dir,
    ffmpegCommand: formatCommand(
      config.ffmpegPath || "ffmpeg",
      ffmpegArguments,
    ),
    error,
  });

  const ffmpeg = await findFfmpeg(config);
  if (!ffmpeg) {
    return kept(
      config.ffmpegPath
        ? `${config.ffmpegPath} (MCP_BROWSER_FFMPEG) is not an executable; the frames are kept in framesDir and ffmpegCommand encodes them`
        : "ffmpeg was not found on PATH (set MCP_BROWSER_FFMPEG to its path); the frames are kept in framesDir and ffmpegCommand encodes them",
    );
  }
  const run = await runFfmpeg(ffmpeg, ffmpegArguments, { spawnFn });
  if (!run.ok) {
    await rm(encoded, { force: true });
    return kept(
      `${run.error}; the frames are kept in framesDir and ffmpegCommand encodes them`,
    );
  }
  await chmod(encoded, SCREENSHOT_FILE_MODE);

  let placed;
  let error;
  if (args.path === undefined) {
    placed = await tempVideoPath();
    await placeVideo(encoded, placed, false);
  } else {
    try {
      // The frame directory is deleted below, so a video placed in it
      // would go with it.
      if (await isInside(capture.dir, args.path)) {
        throw new Error(
          "the path is inside the frame directory, which is deleted after encoding",
        );
      }
      await placeVideo(encoded, args.path, args.overwrite);
      placed = args.path;
    } catch (placeError) {
      // The video is not lost: it goes to a temp file instead.
      placed = await tempVideoPath();
      await placeVideo(encoded, placed, false);
      error = `Could not write ${args.path} (${placeError.message}); the video was saved to a temp file instead`;
    }
  }
  await rm(capture.dir, { recursive: true, force: true });
  return { path: placed, ...summary, ...(error ? { error } : {}) };
}
