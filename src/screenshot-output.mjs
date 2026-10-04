import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function screenshotFormatsFor(browserFamily) {
  return browserFamily === "firefox"
    ? ["png", "jpeg"]
    : ["png", "jpeg", "webp"];
}

export const SCREENSHOT_FILE_FORMATS = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};

export function screenshotFileExtensions(browserFamily) {
  const allowed = screenshotFormatsFor(browserFamily);
  return Object.entries(SCREENSHOT_FILE_FORMATS)
    .filter(([, format]) => allowed.includes(format))
    .map(([extension]) => extension);
}

// Only image extensions are accepted, so a screenshot path can never replace
// a config file or script.
export function screenshotTarget(args, browserFamily) {
  const output = args.output ?? (args.path === undefined ? "data" : "file");
  if (output !== "file") {
    if (args.path !== undefined || args.overwrite !== undefined) {
      throw new Error(
        `take_screenshot path and overwrite require output file, not ${output}`,
      );
    }
    return { output, format: args.format ?? "png", filePath: null };
  }

  if (args.path === undefined) {
    return { output, format: args.format ?? "png", filePath: null };
  }

  if (!path.isAbsolute(args.path)) {
    throw new Error("take_screenshot path must be absolute");
  }

  const format = SCREENSHOT_FILE_FORMATS[path.extname(args.path).toLowerCase()];
  if (!format || !screenshotFormatsFor(browserFamily).includes(format)) {
    throw new Error(
      `take_screenshot path must end with ${screenshotFileExtensions(browserFamily).join(", ")}`,
    );
  }

  if (args.format !== undefined && args.format !== format) {
    throw new Error(
      `take_screenshot format ${args.format} does not match the ${format} path extension`,
    );
  }

  return { output, format, filePath: args.path };
}

// Screenshots can show signed-in pages, so files are private to the user.
export const SCREENSHOT_FILE_MODE = 0o600;

export async function writeTempScreenshot(image, format) {
  // mkdtemp makes a fresh 0700 directory, which other users on a shared /tmp
  // cannot pre-create or read.
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-browser-dev-tools-"));
  const filePath = path.join(
    dir,
    `screenshot.${format === "jpeg" ? "jpg" : format}`,
  );
  await writeFile(filePath, image, { flag: "wx", mode: SCREENSHOT_FILE_MODE });
  return filePath;
}

export async function writeScreenshotFile(filePath, image, overwrite) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!overwrite) {
    // O_EXCL also refuses an existing symlink instead of following it.
    try {
      await writeFile(filePath, image, {
        flag: "wx",
        mode: SCREENSHOT_FILE_MODE,
      });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `${filePath} already exists; pass overwrite: true to replace it`,
          { cause: error },
        );
      }
      throw error;
    }
    return filePath;
  }

  // Renaming a new file into place replaces a symlink at filePath rather
  // than writing through it to a file without an image extension.
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, image, {
      flag: "wx",
      mode: SCREENSHOT_FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return filePath;
}

// The pixel size from a PNG, JPEG, or WebP header, or null.
export function imageSize(image) {
  if (image.length >= 24 && image.readUInt32BE(0) === 0x89504e47) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  if (image.length >= 4 && image[0] === 0xff && image[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < image.length && image[offset] === 0xff) {
      const marker = image[offset + 1];
      const length = image.readUInt16BE(offset + 2);
      const frame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (frame) {
        return {
          width: image.readUInt16BE(offset + 7),
          height: image.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (
    image.length >= 30 &&
    image.toString("ascii", 0, 4) === "RIFF" &&
    image.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = image.toString("ascii", 12, 16);
    if (chunk === "VP8 ") {
      return {
        width: image.readUInt16LE(26) & 0x3fff,
        height: image.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      const bits = image.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8X") {
      return {
        width: image.readUIntLE(24, 3) + 1,
        height: image.readUIntLE(27, 3) + 1,
      };
    }
  }
  return null;
}

// Where the image sits in the viewport and how many image pixels make one
// CSS pixel, so a point seen in the image converts to click coordinates:
// x = cssRect.x + imageX / scale. An element's screenshot covers its clip;
// a page screenshot covers the viewport.
async function screenshotGeometry(server, sessionId, screenshot) {
  const size = imageSize(Buffer.from(screenshot.data, "base64"));
  if (!size) {
    return {};
  }
  let cssRect;
  if (screenshot.clip) {
    const { x, y, width, height } = screenshot.clip;
    cssRect = { x, y, width, height };
  } else {
    try {
      const { viewport } = await server.browserAdapter.getPageState(sessionId);
      cssRect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    } catch {
      return { ...size };
    }
  }
  const scale = cssRect.width > 0 ? size.width / cssRect.width : null;
  return {
    ...size,
    cssRect,
    ...(scale ? { scale: Math.round(scale * 1000) / 1000 } : {}),
  };
}

export async function takeScreenshot(server, args) {
  const { output, format, filePath } = screenshotTarget(
    args,
    server.config.browserFamily,
  );
  const screenshot = await server.browserAdapter.takeScreenshot(
    args.sessionId,
    format,
    {
      selector: args.selector,
    },
  );
  if (screenshot?.found === false) {
    return screenshot;
  }
  if (typeof screenshot?.data === "string") {
    Object.assign(
      screenshot,
      await screenshotGeometry(server, args.sessionId, screenshot),
    );
  }
  if (output !== "file") {
    return screenshot;
  }

  if (typeof screenshot?.data !== "string") {
    throw new Error("The browser returned no screenshot data");
  }

  const { data, ...metadata } = screenshot;
  const image = Buffer.from(data, "base64");
  const savedPath = filePath
    ? await writeScreenshotFile(filePath, image, args.overwrite)
    : await writeTempScreenshot(image, format);
  return { ...metadata, path: savedPath };
}
