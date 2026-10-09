import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  concatList,
  encodeVideo,
  evenSize,
  ffmpegArgs,
  findFfmpeg,
  formatCommand,
  frameDurations,
} from "./video-output.mjs";

test("frameDurations makes each frame last until the next and the last until the stop", () => {
  const frames = [
    { file: "000000.jpg", timestamp: 100 },
    { file: "000001.jpg", timestamp: 100.5 },
    { file: "000002.jpg", timestamp: 100.5 },
    { file: "000003.jpg", timestamp: 100.4 },
    { file: "000004.jpg", timestamp: 101.25 },
  ];
  assert.deepEqual(frameDurations(frames, 103, 30), [
    { file: "000000.jpg", duration: 0.5 },
    { file: "000001.jpg", duration: 0.75 },
    // Until the stop time, less the half frame the repeated copy takes.
    { file: "000004.jpg", duration: 1.733 },
  ]);
  // A last frame right at the stop still has a positive duration.
  assert.deepEqual(frameDurations([{ file: "a.jpg", timestamp: 5 }], 5, 30), [
    { file: "a.jpg", duration: 0.001 },
  ]);
  assert.deepEqual(frameDurations([], 5, 30), []);
});

test("concatList writes the demuxer script with a 1 ms timebase and the last frame repeated", () => {
  assert.equal(
    concatList([
      { file: "000000.jpg", duration: 0.5 },
      { file: "000001.jpg", duration: 1.7333 },
    ]),
    [
      "ffconcat version 1.0",
      "file 000000.jpg",
      "option framerate 1000",
      "duration 0.500",
      "file 000001.jpg",
      "option framerate 1000",
      "duration 1.733",
      "file 000001.jpg",
      "option framerate 1000",
      "",
    ].join("\n"),
  );
  assert.equal(concatList([]), "ffconcat version 1.0\n");
});

test("ffmpegArgs encodes H.264 yuv420p at a constant rate for the capture's length", () => {
  const args = ffmpegArgs({
    listPath: "/tmp/rec/frames.ffconcat",
    fps: 24,
    width: 1920,
    height: 1080,
    durationS: 2.0005,
    outputPath: "/tmp/rec/video.mp4",
  });
  assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 4), [
    "-f",
    "concat",
    "-i",
    "/tmp/rec/frames.ffconcat",
  ]);
  for (const pair of [
    ["-fps_mode", "cfr"],
    ["-r", "24"],
    ["-t", "2.001"],
    ["-c:v", "libx264"],
    ["-pix_fmt", "yuv420p"],
    ["-movflags", "+faststart"],
  ]) {
    assert.equal(args[args.indexOf(pair[0]) + 1], pair[1], pair[0]);
  }
  assert.match(args[args.indexOf("-vf") + 1], /^scale=1920:1080:/);
  assert.equal(args.at(-1), "/tmp/rec/video.mp4");
  assert.deepEqual(evenSize({ width: 1283, height: 721 }), {
    width: 1282,
    height: 720,
  });
  assert.equal(
    formatCommand("/opt/ffmpeg", ["-i", "/tmp/my dir/l.ffconcat", "x.mp4"]),
    "/opt/ffmpeg -i '/tmp/my dir/l.ffconcat' x.mp4",
  );
});

test("findFfmpeg prefers MCP_BROWSER_FFMPEG and otherwise searches PATH", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ffmpeg-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "ffmpeg");
  await writeFile(fake, "#!/bin/sh\nexit 0\n");
  await chmod(fake, 0o755);
  assert.equal(await findFfmpeg({}, { PATH: `${dir}/none:${dir}` }), fake);
  assert.equal(await findFfmpeg({}, { PATH: `${dir}/none` }), null);
  assert.equal(await findFfmpeg({ ffmpegPath: fake }, { PATH: "" }), fake);
  assert.equal(
    await findFfmpeg({ ffmpegPath: `${dir}/missing` }, { PATH: dir }),
    null,
  );
});

async function fakeCapture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "video-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "000000.jpg"), "jpeg");
  await writeFile(path.join(dir, "000001.jpg"), "jpeg");
  return {
    dir,
    frames: [
      { file: "000000.jpg", timestamp: 10 },
      { file: "000001.jpg", timestamp: 11 },
    ],
    startedAt: 10,
    stoppedAt: 12,
    fps: 30,
    width: 1281,
    height: 720,
    warnings: ["Capture stopped at maxDurationMs (2000 ms)"],
  };
}

test("encodeVideo without ffmpeg keeps the frames and returns the command", async (t) => {
  const capture = await fakeCapture(t);
  const result = await encodeVideo(
    capture,
    { path: "/tmp/out.mp4" },
    { ffmpegPath: path.join(capture.dir, "no-ffmpeg") },
  );
  assert.equal(result.framesDir, capture.dir);
  assert.equal(result.path, undefined);
  assert.match(result.error, /MCP_BROWSER_FFMPEG/);
  assert.match(result.error, /frames are kept in framesDir/);
  assert.match(
    result.ffmpegCommand,
    new RegExp(
      `^${capture.dir}/no-ffmpeg .* -i ${capture.dir}/frames.ffconcat .* -t 2.000 .* ${capture.dir}/video.mp4$`,
    ),
  );
  assert.equal(result.durationMs, 2000);
  assert.equal(result.frames, 2);
  assert.equal(result.width, 1280);
  assert.deepEqual(result.warnings, capture.warnings);
  assert.ok((await stat(path.join(capture.dir, "000001.jpg"))).isFile());
  assert.equal(
    await readFile(path.join(capture.dir, "frames.ffconcat"), "utf8"),
    concatList(frameDurations(capture.frames, 12, 30)),
  );

  const notFound = await encodeVideo(capture, {}, {}, {});
  if (!(await findFfmpeg({}))) {
    assert.match(notFound.error, /not found on PATH/);
  }
});

test("encodeVideo reports a failing ffmpeg and keeps the frames", async (t) => {
  const capture = await fakeCapture(t);
  const fake = path.join(capture.dir, "ffmpeg");
  await writeFile(fake, "#!/bin/sh\necho 'bad frame' >&2\nexit 3\n");
  await chmod(fake, 0o755);
  const result = await encodeVideo(capture, {}, { ffmpegPath: fake });
  assert.match(result.error, /ffmpeg exited with 3: bad frame/);
  assert.equal(result.framesDir, capture.dir);
  assert.ok((await stat(path.join(capture.dir, "000000.jpg"))).isFile());
});

test("encodeVideo does not place the video inside the frame directory it deletes", async (t) => {
  const capture = await fakeCapture(t);
  const fake = path.join(capture.dir, "ffmpeg");
  await writeFile(
    fake,
    '#!/bin/sh\nfor last; do :; done\necho mp4 > "$last"\n',
  );
  await chmod(fake, 0o755);
  const result = await encodeVideo(
    capture,
    { path: path.join(capture.dir, "demo.mp4") },
    { ffmpegPath: fake },
  );
  t.after(() =>
    rm(path.dirname(result.path), { recursive: true, force: true }),
  );
  assert.match(result.error, /inside the frame directory/);
  assert.match(result.path, /video\.mp4$/);
  assert.equal(await readFile(result.path, "utf8"), "mp4\n");
  assert.equal(
    await stat(capture.dir).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("encodeVideo catches the frame directory reached through a symlink alias", async (t) => {
  const capture = await fakeCapture(t);
  const fake = path.join(capture.dir, "ffmpeg");
  await writeFile(
    fake,
    '#!/bin/sh\nfor last; do :; done\necho mp4 > "$last"\n',
  );
  await chmod(fake, 0o755);
  const aliasRoot = await mkdtemp(path.join(tmpdir(), "video-alias-"));
  t.after(() => rm(aliasRoot, { recursive: true, force: true }));
  const alias = path.join(aliasRoot, "frames");
  await symlink(capture.dir, alias);
  const result = await encodeVideo(
    capture,
    { path: path.join(alias, "sub", "demo.mp4") },
    { ffmpegPath: fake },
  );
  t.after(() =>
    rm(path.dirname(result.path), { recursive: true, force: true }),
  );
  assert.match(result.error, /inside the frame directory/);
  assert.equal(await readFile(result.path, "utf8"), "mp4\n");
});
