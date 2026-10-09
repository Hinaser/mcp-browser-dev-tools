import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SCREENSHOT_FILE_MODE,
  writeScreenshotFile,
} from "../screenshot-output.mjs";
import { sessionSchema } from "../tool-schemas.mjs";
import { checkVideoPath, encodeVideo } from "../video-output.mjs";

// A trace can show signed-in pages, so it is written like a screenshot:
// private to the user, never through a symlink, and not over an existing
// file unless asked.
async function writeTempTrace(data) {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-browser-dev-tools-"));
  const file = path.join(dir, "trace.json");
  await writeFile(file, data, { flag: "wx", mode: SCREENSHOT_FILE_MODE });
  return file;
}

// Checked before the trace stops, so a bad path does not cost the trace.
async function checkTracePath(args) {
  if (args.path === undefined) {
    return;
  }
  if (!path.isAbsolute(args.path) || !args.path.endsWith(".json")) {
    throw new Error("record_trace path must be absolute and end in .json");
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

// A trace that cannot be written where asked goes to a temp file instead,
// so the recording is not lost.
async function writeTrace(data, args) {
  if (args.path === undefined) {
    return { path: await writeTempTrace(data) };
  }
  try {
    return { path: await writeScreenshotFile(args.path, data, args.overwrite) };
  } catch (error) {
    return {
      path: await writeTempTrace(data),
      error: `Could not write ${args.path} (${error.message}); the trace was saved to a temp file instead`,
    };
  }
}

export function performanceTools(server) {
  return [
    [
      "get_performance",
      {
        definition: {
          name: "get_performance",
          description:
            "Load timing, Web Vitals (TTFB, FCP, LCP with its element, CLS, slowest interaction) with ratings, long tasks, and the slowest resources; on Chromium also heap, DOM, layout, and script counters.",
          inputSchema: sessionSchema({}, []),
        },
        handler: async (args) =>
          server.browserAdapter.getPerformance(args.sessionId),
      },
    ],
    [
      "record_trace",
      {
        definition: {
          name: "record_trace",
          description:
            "Record a Chromium performance trace: start, act, then stop writes a JSON file that DevTools' Performance panel opens.",
          inputSchema: sessionSchema(
            {
              action: { type: "string", enum: ["start", "stop"] },
              screenshots: {
                type: "boolean",
                description: "With start: include filmstrip screenshots.",
              },
              path: {
                type: "string",
                description:
                  "With stop: absolute .json path; default a temp file.",
              },
              overwrite: { type: "boolean" },
            },
            ["action"],
          ),
        },
        handler: async (args) => {
          if (args.action === "start") {
            return server.browserAdapter.startTrace(args.sessionId, {
              screenshots: args.screenshots,
            });
          }
          await checkTracePath(args);
          const { data, durationMs } = await server.browserAdapter.stopTrace(
            args.sessionId,
          );
          return {
            ...(await writeTrace(data, args)),
            bytes: data.length,
            durationMs,
          };
        },
      },
    ],
    [
      "record_video",
      {
        definition: {
          name: "record_video",
          description:
            "Record what a Chromium tab shows to an MP4: start, act, then stop encodes the frames with ffmpeg (on PATH or MCP_BROWSER_FFMPEG; without it, stop returns the frames and the command). For 1920x1080, set_viewport first.",
          inputSchema: sessionSchema(
            {
              action: { type: "string", enum: ["start", "stop"] },
              fps: {
                type: "integer",
                minimum: 1,
                maximum: 60,
                description: "With start: output frame rate; default 30.",
              },
              quality: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: "With start: JPEG quality; default 80.",
              },
              maxWidth: {
                type: "integer",
                minimum: 1,
                description:
                  "With start: frames are scaled to fit; default the viewport.",
              },
              maxHeight: { type: "integer", minimum: 1 },
              maxDurationMs: {
                type: "integer",
                minimum: 1000,
                maximum: 1_800_000,
                description:
                  "With start: capture stops by itself after this; default 600000.",
              },
              path: {
                type: "string",
                description:
                  "With stop: absolute .mp4 path; default a temp file.",
              },
              overwrite: { type: "boolean" },
            },
            ["action"],
          ),
        },
        handler: async (args) => {
          if (args.action === "start") {
            const { dir, recording } = await server.browserAdapter.startVideo(
              args.sessionId,
              {
                fps: args.fps,
                quality: args.quality,
                maxWidth: args.maxWidth,
                maxHeight: args.maxHeight,
                maxDurationMs: args.maxDurationMs,
              },
            );
            return { recording, dir };
          }
          await checkVideoPath(args);
          const capture = await server.browserAdapter.stopVideo(args.sessionId);
          return encodeVideo(capture, args, server.config);
        },
      },
    ],
  ];
}
