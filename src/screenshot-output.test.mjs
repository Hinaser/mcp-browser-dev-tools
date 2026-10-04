import test from "node:test";

import assert from "node:assert/strict";

import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import {
  callRunSteps,
  callTool,
  createFakeManager,
} from "./mcp-test-support.mjs";

test("take_screenshot forwards the optional selector", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 35,
    method: "tools/call",
    params: {
      name: "take_screenshot",
      arguments: {
        sessionId: "session-1",
        selector: "text=Open modal",
      },
    },
  });

  assert.equal(response.result.structuredContent.selector, "text=Open modal");
});

test("take_screenshot with path writes the decoded image and returns its path", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshot-as-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = createFakeManager();
  let requestedFormat;
  manager.takeScreenshot = async (sessionId, format) => {
    requestedFormat = format;
    return {
      format,
      mimeType: "image/jpeg",
      encoding: "base64",
      data: Buffer.from("raw-image").toString("base64"),
      scope: "page",
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });
  const filePath = path.join(dir, "nested", "shot.JPG");

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: filePath,
  });

  const value = response.result.structuredContent;
  assert.equal(requestedFormat, "jpeg");
  assert.equal(value.path, filePath);
  assert.equal(value.data, undefined);
  assert.equal(value.scope, "page");
  assert.equal(await readFile(filePath, "utf8"), "raw-image");

  const again = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: filePath,
  });
  assert.match(again.error.message, /already exists/);

  const replaced = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: filePath,
    overwrite: true,
  });
  assert.equal(replaced.result.structuredContent.path, filePath);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("take_screenshot replaces a symlink instead of writing through it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshot-as-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, ".bashrc");
  const link = path.join(dir, "shot.png");
  await writeFile(config, "keep");
  await symlink(config, link);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const refused = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: link,
  });
  assert.match(refused.error.message, /already exists/);

  await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    path: link,
    overwrite: true,
  });
  assert.equal(await readFile(config, "utf8"), "keep");
  assert.equal(await readFile(link, "utf8"), "fake");
});

test("take_screenshot fails when the selector matches nothing", async () => {
  const manager = createFakeManager();
  manager.takeScreenshot = async (sessionId, format, options) => ({
    format,
    scope: "element",
    selector: options.selector,
    found: false,
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const response = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "take_screenshot", arguments: { selector: "#missing" } },
      { tool: "get_page_state" },
    ],
  });

  const value = response.result.structuredContent;
  assert.equal(value.ok, false);
  assert.equal(value.skippedSteps, 1);
  assert.match(value.steps[0].error, /No element matches selector #missing/);
});

test("take_screenshot output file defaults to a temp file", async (t) => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    output: "file",
    format: "webp",
  });

  const filePath = response.result.structuredContent.path;
  t.after(() => rm(path.dirname(filePath), { recursive: true, force: true }));
  assert.ok(filePath.startsWith(tmpdir()));
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.match(filePath, /\.webp$/);
  assert.equal(await readFile(filePath, "utf8"), "fake");
});

test("take_screenshot rejects unsafe or mismatched paths before capturing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshot-as-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = createFakeManager();
  let captured = false;
  manager.takeScreenshot = async () => {
    captured = true;
    return {};
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });
  const config = path.join(dir, ".bashrc");
  await writeFile(config, "keep");

  const cases = [
    [{ path: "shot.png" }, /must be absolute/],
    [{ path: config }, /must end with \.png/],
    [{ path: path.join(dir, "a.png"), format: "jpeg" }, /does not match/],
    [{ path: path.join(dir, "b.png"), output: "image" }, /require output file/],
    [{ overwrite: true }, /require output file/],
  ];
  for (const [args, pattern] of cases) {
    const response = await callTool(server, "take_screenshot", {
      sessionId: "session-1",
      ...args,
    });
    assert.match(response.error.message, pattern);
  }

  const firefox = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_FAMILY: "firefox",
    }),
    browserAdapter: manager,
  });
  const webp = await callTool(firefox, "take_screenshot", {
    sessionId: "session-1",
    path: path.join(dir, "a.webp"),
  });
  assert.match(webp.error.message, /must end with \.png, \.jpg, \.jpeg$/);

  assert.equal(captured, false);
  assert.equal(await readFile(config, "utf8"), "keep");
});

test("take_screenshot output image returns image content without base64 text", async () => {
  const manager = createFakeManager();
  manager.takeScreenshot = async (sessionId, format) => ({
    format,
    mimeType: "image/png",
    encoding: "base64",
    data: "ZmFrZQ==",
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    output: "image",
  });

  assert.equal(response.result.structuredContent.data, undefined);
  assert.equal(response.result.structuredContent.image, 1);
  assert.doesNotMatch(response.result.content[0].text, /ZmFrZQ==/);
  assert.deepEqual(response.result.content[1], {
    type: "image",
    data: "ZmFrZQ==",
    mimeType: "image/png",
  });
});

test("take_screenshot without new arguments still returns base64 data", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await callTool(server, "take_screenshot", {
    sessionId: "session-1",
  });

  assert.equal(response.result.structuredContent.data, "ZmFrZQ==");
  assert.equal(response.result.content.length, 1);
});

function png(width, height) {
  const image = Buffer.alloc(33);
  image.writeUInt32BE(0x89504e47, 0);
  image.writeUInt32BE(0x0d0a1a0a, 4);
  image.write("IHDR", 12, "ascii");
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

test("imageSize reads PNG, JPEG, and WebP headers", async () => {
  const { imageSize } = await import("./screenshot-output.mjs");
  assert.deepEqual(imageSize(png(2356, 1510)), { width: 2356, height: 1510 });

  // SOI, an APP0 segment, then a baseline frame header.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
    0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.deepEqual(imageSize(jpeg), { width: 1280, height: 720 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUIntLE(799, 24, 3);
  webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 800, height: 600 });

  assert.equal(imageSize(Buffer.from("not an image")), null);
});

test("take_screenshot reports the CSS area it covers and its scale", async () => {
  const manager = createFakeManager();
  manager.takeScreenshot = async (sessionId, format, options) => ({
    format,
    mimeType: "image/png",
    encoding: "base64",
    data: png(
      options.selector ? 200 : 2560,
      options.selector ? 80 : 1440,
    ).toString("base64"),
    ...(options.selector
      ? { clip: { x: 30, y: 100, width: 100, height: 40, scale: 1 } }
      : {}),
  });
  manager.getPageState = async () => ({
    viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const page = (await callTool(server, "take_screenshot", { sessionId: "s" }))
    .result.structuredContent;
  assert.deepEqual(
    {
      width: page.width,
      height: page.height,
      cssRect: page.cssRect,
      scale: page.scale,
    },
    {
      width: 2560,
      height: 1440,
      cssRect: { x: 0, y: 0, width: 1280, height: 720 },
      scale: 2,
    },
  );

  const element = (
    await callTool(server, "take_screenshot", {
      sessionId: "s",
      selector: "#save",
    })
  ).result.structuredContent;
  assert.deepEqual(element.cssRect, { x: 30, y: 100, width: 100, height: 40 });
  assert.equal(element.scale, 2);
});
