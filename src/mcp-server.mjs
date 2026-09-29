import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { encodeMessage, MessageBuffer } from "./json-rpc-stdio.mjs";
import { createLogger } from "./logger.mjs";
import {
  launchBrowser as launchLocalBrowser,
  supportedLaunchFamilies,
} from "./browser-launch-service.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";
import { checkPageCondition, normalizeWaitForOptions } from "./wait-for.mjs";

const SERVER_NAME = PACKAGE_NAME;
const SERVER_VERSION = PACKAGE_VERSION;

function formatChunkPreview(chunk, limit = 160) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return buffer
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function success(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function asToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function asImageToolResult({ value, images }) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
      ...images,
    ],
    structuredContent: value,
  };
}

function emptyObjectSchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

function validateValue(path, value, schema) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }

    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (value[key] === undefined) {
        throw new Error(`${path}.${key} is required`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${path}.${key} is not allowed`);
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateValue(`${path}.${key}`, value[key], propertySchema);
      }
    }

    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array`);
    }

    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} must have at least ${schema.minItems} items`);
    }

    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} must have at most ${schema.maxItems} items`);
    }

    if (schema.items) {
      value.forEach((item, index) => {
        validateValue(`${path}[${index}]`, item, schema.items);
      });
    }

    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${path} must be a string`);
    }

    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
    }

    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${path} must be a boolean`);
    }

    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${path} must be an integer`);
    }

    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} must be >= ${schema.minimum}`);
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`${path} must be <= ${schema.maximum}`);
    }

    return;
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`${path} must be a number`);
    }

    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} must be >= ${schema.minimum}`);
    }
  }
}

function screenshotFormatsFor(browserFamily) {
  return browserFamily === "firefox"
    ? ["png", "jpeg"]
    : ["png", "jpeg", "webp"];
}

const SCREENSHOT_FILE_FORMATS = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};

function screenshotFileExtensions(browserFamily) {
  const allowed = screenshotFormatsFor(browserFamily);
  return Object.entries(SCREENSHOT_FILE_FORMATS)
    .filter(([, format]) => allowed.includes(format))
    .map(([extension]) => extension);
}

// Only image extensions are accepted, so a screenshot path can never replace
// a config file or script.
function screenshotTarget(args, browserFamily) {
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
const SCREENSHOT_FILE_MODE = 0o600;

async function writeTempScreenshot(image, format) {
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

async function writeScreenshotFile(filePath, image, overwrite) {
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

function sessionWithLimitSchema(description) {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description:
          "Return the most recent N entries from the session buffer (default 50).",
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
    description,
  };
}

const LOCATOR_DESCRIPTION =
  'Element locator. Plain CSS (or css=...) resolves to the first document.querySelector match. text=Foo resolves to the first visible element whose whitespace-normalized text equals Foo, falling back to the first whose text contains Foo; elements are scanned in document order, so this can resolve to a wrapper around the element you want. role=button or role=button[name="Save"] matches by explicit or implicit ARIA role and, optionally, accessible name (equal or containing), without a visibility check. name=Foo resolves to the first visible element whose accessible name (aria-label, aria-labelledby, associated label, alt, and so on) equals or contains Foo. Text comparisons are case-sensitive. Only the top-level document is searched: elements inside iframes or shadow roots are not found.';

function selectorProperty() {
  return {
    type: "string",
    description: LOCATOR_DESCRIPTION,
  };
}

function sessionSchema(properties, required, description) {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      ...properties,
    },
    required: ["sessionId", ...required],
    additionalProperties: false,
    description,
  };
}

function waitUntilProperty() {
  return {
    type: "string",
    enum: ["none", "interactive", "complete"],
    description:
      "When to return: none returns once navigation starts, interactive after DOMContentLoaded, complete after the load event (default complete).",
  };
}

function pageConditionProperties() {
  return {
    selector: selectorProperty(),
    state: {
      type: "string",
      enum: ["present", "visible", "hidden"],
      description:
        "Selector state (default visible). present: in the DOM. hidden: absent or not visible. Requires selector.",
    },
    url: {
      type: "string",
      description: "The page URL equals this string exactly.",
    },
    urlIncludes: {
      type: "string",
      description: "The page URL contains this string.",
    },
    readyState: {
      type: "string",
      enum: ["interactive", "complete"],
      description: "document.readyState has reached this state or later.",
    },
    textEquals: {
      type: "string",
      description:
        "The selector's visible text equals this string, comparing with whitespace collapsed; only the first 400 characters of the element's text are read, so textEquals never matches longer text. Requires selector; not with state hidden.",
    },
    textIncludes: {
      type: "string",
      description:
        "The selector's visible text contains this string, comparing with whitespace collapsed; only the first 400 characters of the element's text are searched. Requires selector; not with state hidden.",
    },
  };
}

function waitForInputSchema() {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      ...pageConditionProperties(),
      timeoutMs: {
        type: "integer",
        minimum: 1,
        description: "How long to wait before failing (default 10000).",
      },
      pollIntervalMs: {
        type: "integer",
        minimum: 1,
        description: "Delay between checks (default 100).",
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
  };
}

const MAX_RUN_STEPS = 50;
const MAX_STEP_DEPTH = 4;
const MAX_SLEEP_MS = 30_000;

function sleepStepSchema() {
  return {
    type: "object",
    properties: {
      ms: {
        type: "integer",
        minimum: 0,
        maximum: MAX_SLEEP_MS,
        description: `Milliseconds to wait (at most ${MAX_SLEEP_MS}).`,
      },
    },
    required: ["ms"],
    additionalProperties: false,
  };
}

function ifStepSchema() {
  const condition = {
    type: "object",
    properties: pageConditionProperties(),
    additionalProperties: false,
  };
  const steps = {
    type: "array",
    items: { type: "object" },
  };
  return {
    type: "object",
    properties: {
      condition,
      then: steps,
      elseIf: {
        type: "array",
        items: {
          type: "object",
          properties: { condition, then: steps },
          required: ["condition"],
          additionalProperties: false,
        },
      },
      else: steps,
    },
    required: ["condition"],
    additionalProperties: false,
  };
}

function stepSchema(stepTools) {
  return {
    type: "object",
    properties: {
      tool: {
        type: "string",
        enum: ["sleep", "if", ...stepTools],
        description:
          "A tool that takes sessionId, sleep to pause, or if to branch.",
      },
      arguments: {
        type: "object",
        description:
          "That tool's arguments without sessionId (default {}). sleep takes { ms }. if takes { condition, then, elseIf, else }: each condition has the wait_for condition fields, checked once without waiting, all of which must hold; then and else are step lists; elseIf is a list of { condition, then } checked in order after condition, and the first condition that holds runs its then.",
      },
    },
    required: ["tool"],
    additionalProperties: false,
  };
}

function runStepsInputSchema(stepTools) {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description:
          "Session id returned by attach_tab. Every step runs on this session.",
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: MAX_RUN_STEPS,
        description: `Steps to run in order (at most ${MAX_RUN_STEPS}, counting steps inside if branches; if nests at most ${MAX_STEP_DEPTH} deep).`,
        items: stepSchema(stepTools),
      },
      continueOnError: {
        type: "boolean",
        description:
          "Run the remaining steps after a step fails (default false: stop at the first failure).",
      },
    },
    required: ["sessionId", "steps"],
    additionalProperties: false,
  };
}

function moveScreenshotImage(screenshot, images) {
  if (typeof screenshot?.data !== "string") {
    return screenshot;
  }

  const { data, ...metadata } = screenshot;
  images.push({ type: "image", data, mimeType: screenshot.mimeType });
  return { ...metadata, image: images.length };
}

// Moves screenshot data out of a step result so the client receives it as
// image content, leaving `image` (1-based position among the images) behind.
function extractStepImages(tool, result, images) {
  if (tool === "take_screenshot") {
    return moveScreenshotImage(result, images);
  }

  if (tool === "capture_debug_report" && result?.screenshot) {
    return {
      ...result,
      screenshot: moveScreenshotImage(result.screenshot, images),
    };
  }

  return result;
}

function parseSessionSnapshot(text) {
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error("restore_session_snapshot snapshot must be valid JSON");
  }

  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(
      "restore_session_snapshot snapshot must decode to an object",
    );
  }

  return snapshot;
}

function compareSessionsSchema(properties, required) {
  return {
    type: "object",
    properties: {
      sessionIdA: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      sessionIdB: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      ...properties,
    },
    required: ["sessionIdA", "sessionIdB", ...required],
    additionalProperties: false,
  };
}

function storageInputSchema() {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      area: {
        type: "string",
        enum: ["all", "localStorage", "sessionStorage"],
        description: "Which storage to return (default all).",
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
  };
}

function captureDebugReportInputSchema(browserFamily) {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      consoleLimit: {
        type: "integer",
        minimum: 1,
        description: "Most recent console entries to include (default 20).",
      },
      networkLimit: {
        type: "integer",
        minimum: 1,
        description: "Most recent network requests to include (default 20).",
      },
      includeScreenshot: {
        type: "boolean",
        description: "Include a viewport screenshot (default true).",
      },
      screenshotFormat: {
        type: "string",
        enum: screenshotFormatsFor(browserFamily),
        description: "Screenshot image format (default png).",
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
  };
}

function restoreSessionSnapshotInputSchema() {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      snapshot: {
        type: "string",
        description:
          "The JSON output of capture_session_snapshot, as a string. Only entries for the current page origin are restored.",
      },
      clearStorage: {
        type: "boolean",
        description:
          "Clear localStorage and sessionStorage before restoring (default false).",
      },
    },
    required: ["sessionId", "snapshot"],
    additionalProperties: false,
  };
}

function newTabInputSchema(browserFamily) {
  const properties = {
    url: {
      type: "string",
      description: "URL to open (default about:blank).",
    },
  };
  const required = [];

  if (browserFamily === "auto") {
    properties.browserFamily = {
      type: "string",
      enum: ["chromium", "firefox"],
      description: "Browser to open the tab in.",
    };
    required.push("browserFamily");
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function unsafeArgsProperty() {
  return {
    type: "array",
    items: {
      type: "string",
    },
    description:
      "Extra browser command-line flags, each starting with -. Flags that conflict with broker-managed launch options (debugging port, address, profile) are rejected.",
  };
}

function launchBrowserInputSchema(browserFamily, enableUnsafeLaunchArgs) {
  const properties = {
    url: {
      type: "string",
      description: "URL to open in the launched browser (default about:blank).",
    },
    browserFamily: {
      type: "string",
      enum: supportedLaunchFamilies(browserFamily),
      description:
        "Browser to launch. Required when the broker runs in auto mode.",
    },
    port: {
      type: "integer",
      minimum: 1,
      description:
        "Remote debugging port to launch on (default: the port of the configured browser endpoint, usually 9222).",
    },
    address: {
      type: "string",
      description:
        "Remote debugging bind address for Chromium and Edge (ignored for Firefox). Must be loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1.",
    },
    userDataDir: {
      type: "string",
      description:
        "Browser profile directory for a new launch (default: MCP_BROWSER_USER_DATA_DIR when set). Without either, Chromium and Edge get a fresh temporary profile if that browser is already running, and the default profile otherwise.",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      description:
        "How long to wait for the debugging endpoint to answer after launch (default 5000).",
    },
    skipDoctor: {
      type: "boolean",
      description:
        "Return right after spawning the browser, without waiting for the endpoint or running the doctor report (default false).",
    },
  };
  if (enableUnsafeLaunchArgs) {
    properties.unsafeArgs = unsafeArgsProperty();
  }
  const required = browserFamily === "auto" ? ["browserFamily"] : [];

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function ensureBrowserInputSchema(browserFamily, enableUnsafeLaunchArgs) {
  const properties = {
    browserFamily: {
      type: "string",
      enum: supportedLaunchFamilies(browserFamily),
      description:
        "Browser to check or launch. Required when the broker runs in auto mode.",
    },
    url: {
      type: "string",
      description: "URL to open in a new tab once the browser is reachable.",
    },
    createTab: {
      type: "boolean",
      description:
        "Open a tab after the browser is reachable (default: true when url is given).",
    },
    launchIfMissing: {
      type: "boolean",
      description:
        "Launch a browser when none is reachable (default true). When false and none is reachable, return the status without launching or opening a tab.",
    },
    port: {
      type: "integer",
      minimum: 1,
      description:
        "Remote debugging port to launch on (default: the port of the configured browser endpoint, usually 9222).",
    },
    address: {
      type: "string",
      description:
        "Remote debugging bind address for Chromium and Edge (ignored for Firefox). Must be loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1.",
    },
    userDataDir: {
      type: "string",
      description:
        "Browser profile directory for a new launch (default: MCP_BROWSER_USER_DATA_DIR when set). Without either, Chromium and Edge get a fresh temporary profile if that browser is already running, and the default profile otherwise.",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      description:
        "How long to wait for the debugging endpoint to answer after launch (default 5000).",
    },
    skipDoctor: {
      type: "boolean",
      description:
        "Return right after spawning the browser, without waiting for the endpoint or running the doctor report (default false).",
    },
  };
  if (enableUnsafeLaunchArgs) {
    properties.unsafeArgs = unsafeArgsProperty();
  }

  return {
    type: "object",
    properties,
    required: browserFamily === "auto" ? ["browserFamily"] : [],
    additionalProperties: false,
  };
}

function requestedBrowserFamily(configuredFamily, requestedFamily) {
  if (requestedFamily) {
    return requestedFamily;
  }

  return configuredFamily === "auto" ? null : configuredFamily;
}

function isRequestedBrowserAvailable(
  status,
  configuredFamily,
  requestedFamily,
) {
  if (configuredFamily !== "auto" || !requestedFamily) {
    return Boolean(status?.available);
  }

  // Edge shares the Chromium adapter in auto mode.
  const adapterFamily =
    requestedFamily === "edge" ? "chromium" : requestedFamily;
  return Boolean(status?.browsers?.[adapterFamily]?.available);
}

const STATUS_PROBE_ATTEMPTS = 3;
const LAUNCH_GRACE_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldCreateBrowserTab(args) {
  if (args.createTab !== undefined) {
    return args.createTab;
  }

  return typeof args.url === "string" && args.url.trim() !== "";
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareField(left, right) {
  return {
    equal: sameValue(left, right),
    a: left,
    b: right,
  };
}

function summarizeComparablePageState(page = {}) {
  return {
    browserFamily: page.browserFamily ?? null,
    url: page.url ?? null,
    title: page.title ?? null,
    readyState: page.readyState ?? null,
    visibilityState: page.visibilityState ?? null,
    viewport: page.viewport ?? null,
    scroll: page.scroll ?? null,
  };
}

function summarizeComparableElement(result = {}) {
  if (!result.found || !result.node) {
    return {
      found: false,
      selector: result.selector ?? null,
      error: result.error ?? null,
    };
  }

  return {
    found: true,
    selector: result.selector ?? null,
    tagName: result.node.tagName ?? null,
    accessibleName: result.node.accessibleName ?? null,
    role: result.node.role ?? null,
    visible: result.node.visible ?? null,
    disabled: result.node.disabled ?? null,
    textContent: result.node.textContent ?? null,
  };
}

export class McpBrowserDevToolsServer {
  constructor({
    config,
    browserAdapter,
    launchBrowser = launchLocalBrowser,
    statusProbeRetryMs = 500,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    logger = createLogger({
      level: config.logLevel,
      output: errorOutput,
      name: SERVER_NAME,
    }),
  }) {
    this.config = config;
    this.browserAdapter = browserAdapter;
    this.launchBrowser = launchBrowser;
    this.statusProbeRetryMs = statusProbeRetryMs;
    this.launchQueue = Promise.resolve();
    this.unconfirmedLaunches = new Map();
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.logger = logger;
    this.messageBuffer = new MessageBuffer();
    this.tools = this.createTools();
  }

  // Runs launch decisions one at a time, so parallel tool calls see the browser
  // the first call started instead of each launching their own.
  runExclusiveLaunch(task) {
    const run = this.launchQueue.then(task, task);
    this.launchQueue = run.catch(() => {});
    return run;
  }

  // A busy browser can miss a single status check, and treating that as "not
  // running" would launch a second browser, so retry before giving up.
  async probeBrowser(browserFamily) {
    let status = null;
    for (let attempt = 0; attempt < STATUS_PROBE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.statusProbeRetryMs);
      }

      status = await this.browserAdapter.getBrowserStatus();
      if (
        isRequestedBrowserAvailable(
          status,
          this.config.browserFamily,
          browserFamily,
        )
      ) {
        this.unconfirmedLaunches.delete(
          browserFamily ?? this.config.browserFamily,
        );
        return { status, available: true };
      }
    }

    return { status, available: false };
  }

  // A browser can take a while to expose its endpoint after launch. Launching
  // again in that window would start a second browser, so refuse until the
  // first one answers or the grace period passes.
  async launchUnlessPending(browserFamily, options) {
    const key = browserFamily ?? this.config.browserFamily;
    const launchedAt = this.unconfirmedLaunches.get(key);
    if (launchedAt !== undefined && Date.now() - launchedAt < LAUNCH_GRACE_MS) {
      const seconds = Math.round((Date.now() - launchedAt) / 1000);
      throw new Error(
        `A ${key} browser launched ${seconds}s ago has not exposed its debugging endpoint yet, so another one was not launched. Wait a few seconds and call ensure_browser again.`,
      );
    }

    const launch = await this.launchBrowser(options);
    const confirmed =
      launch?.launched === false ||
      launch?.doctorReport?.browserStatus?.available === true;
    if (confirmed) {
      this.unconfirmedLaunches.delete(key);
    } else {
      this.unconfirmedLaunches.set(key, Date.now());
    }
    return launch;
  }

  async ensureBrowser(args) {
    const browserFamily = requestedBrowserFamily(
      this.config.browserFamily,
      args.browserFamily,
    );
    const { status: currentStatus, available } =
      await this.probeBrowser(browserFamily);
    let launch = null;
    let status = currentStatus;

    if (!available) {
      if (args.launchIfMissing === false) {
        return {
          browserFamily,
          available: false,
          launched: false,
          status,
          tab: null,
        };
      }

      launch = await this.launchUnlessPending(browserFamily, {
        config: this.config,
        browserFamily,
        url: args.url,
        port: args.port,
        address: args.address,
        userDataDir: args.userDataDir,
        unsafeArgs: args.unsafeArgs,
        waitMs: args.waitMs,
        skipDoctor: args.skipDoctor,
      });
      ({ status } = await this.probeBrowser(browserFamily));
    }

    let tab = null;
    if (shouldCreateBrowserTab(args)) {
      tab = await this.browserAdapter.createTab(args.url, {
        browserFamily,
      });
    }

    return {
      browserFamily,
      available: isRequestedBrowserAvailable(
        status,
        this.config.browserFamily,
        browserFamily,
      ),
      launched: Boolean(launch) && launch.launched !== false,
      launch,
      status,
      tab,
    };
  }

  async takeScreenshot(args) {
    const { output, format, filePath } = screenshotTarget(
      args,
      this.config.browserFamily,
    );
    const screenshot = await this.browserAdapter.takeScreenshot(
      args.sessionId,
      format,
      {
        selector: args.selector,
      },
    );
    if (output !== "file" || screenshot?.found === false) {
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

  prepareSteps(steps, context, pathPrefix, depth) {
    return steps.map((step, index) => {
      const stepPath = `${pathPrefix}[${index}]`;
      validateValue(stepPath, step, this.stepSchema);
      context.count += 1;
      if (context.count > MAX_RUN_STEPS) {
        throw new Error(
          `run_steps allows at most ${MAX_RUN_STEPS} steps, counting steps inside if branches`,
        );
      }

      const path = `${stepPath}.arguments`;
      const stepArgs = step.arguments ?? {};
      if (step.tool === "sleep") {
        validateValue(path, stepArgs, sleepStepSchema());
        return { tool: step.tool, args: stepArgs };
      }

      if (step.tool === "if") {
        if (depth >= MAX_STEP_DEPTH) {
          throw new Error(
            `${path} nests if deeper than ${MAX_STEP_DEPTH} levels`,
          );
        }
        validateValue(path, stepArgs, ifStepSchema());
        const prepareBranch = (branch, branchPath) => ({
          condition: normalizeWaitForOptions(
            branch.condition,
            `${branchPath}.condition`,
          ),
          steps: this.prepareSteps(
            branch.then ?? [],
            context,
            `${branchPath}.then`,
            depth + 1,
          ),
        });
        return {
          tool: step.tool,
          branches: [
            { name: "then", ...prepareBranch(stepArgs, path) },
            ...(stepArgs.elseIf ?? []).map((branch, branchIndex) => ({
              name: `elseIf[${branchIndex}]`,
              ...prepareBranch(branch, `${path}.elseIf[${branchIndex}]`),
            })),
          ],
          else: this.prepareSteps(
            stepArgs.else ?? [],
            context,
            `${path}.else`,
            depth + 1,
          ),
        };
      }

      if (stepArgs.sessionId !== undefined) {
        throw new Error(
          `${path}.sessionId is not allowed; run_steps passes its own sessionId`,
        );
      }

      const toolArgs = { ...stepArgs, sessionId: context.sessionId };
      const tool = this.tools.get(step.tool);
      validateValue(path, toolArgs, tool.definition.inputSchema);
      tool.validate?.(toolArgs);
      return { tool: step.tool, args: toolArgs };
    });
  }

  async checkStepCondition(condition, context) {
    const check = await checkPageCondition({
      getPageState: () => this.browserAdapter.getPageState(context.sessionId),
      inspectElement: (selector) =>
        this.browserAdapter.inspectElement(context.sessionId, selector),
      normalized: condition,
    });
    const observed = {};
    if (check.page) {
      observed.url = check.page.url ?? null;
      observed.readyState = check.page.readyState ?? null;
    }
    if (condition.selector) {
      observed.found = Boolean(check.element?.found);
      observed.visible = check.element?.node?.visible === true;
      if (condition.textEquals !== null || condition.textIncludes !== null) {
        observed.text = check.text;
      }
    }
    return { matched: check.matched, observed };
  }

  // Checks the then and elseIf conditions in order and runs the first branch
  // whose condition holds, or else when none does.
  async runIfStep(step, context) {
    const checked = [];
    let selected = null;
    for (const branch of step.branches) {
      const { matched, observed } = await this.checkStepCondition(
        branch.condition,
        context,
      );
      checked.push({ branch: branch.name, matched, observed });
      if (matched) {
        selected = branch;
        break;
      }
    }

    const steps = await this.executeSteps(
      selected ? selected.steps : step.else,
      context,
    );
    return {
      ok: steps.every((result) => result.ok),
      result: {
        matched: selected !== null,
        branch: selected ? selected.name : "else",
        checked,
        steps,
      },
    };
  }

  async runStep(step, context) {
    if (step.tool === "if") {
      return this.runIfStep(step, context);
    }

    let result;
    if (step.tool === "sleep") {
      await sleep(step.args.ms);
      result = { sleptMs: step.args.ms };
    } else {
      result = await this.tools.get(step.tool).handler(step.args);
    }

    const entry = {
      ok: true,
      result: extractStepImages(step.tool, result, context.images),
    };
    // Actions report a missing element as found: false instead of throwing;
    // later steps usually depend on it, so treat it as a failure.
    // inspect_element may be checking that something is gone.
    if (result?.found === false && step.tool !== "inspect_element") {
      entry.ok = false;
      entry.error =
        result.error ?? `No element matches selector ${step.args.selector}`;
    }
    return entry;
  }

  async executeSteps(steps, context) {
    const results = [];
    for (const [index, step] of steps.entries()) {
      const startedAt = Date.now();
      let entry;
      try {
        entry = await this.runStep(step, context);
      } catch (error) {
        entry = { ok: false, error: error.message };
      }

      results.push({
        index,
        tool: step.tool,
        durationMs: Date.now() - startedAt,
        ...entry,
      });
      if (!entry.ok && !context.continueOnError) {
        break;
      }
    }
    return results;
  }

  async runSteps(args) {
    const context = {
      sessionId: args.sessionId,
      continueOnError: args.continueOnError === true,
      images: [],
      count: 0,
    };
    // Validate every step, including both branches of each if, first, so a
    // typo in a late step does not leave the page half-changed.
    const steps = this.prepareSteps(args.steps, context, "arguments.steps", 0);
    const results = await this.executeSteps(steps, context);

    return {
      value: {
        sessionId: args.sessionId,
        ok:
          results.length === steps.length &&
          results.every((result) => result.ok),
        ranSteps: results.length,
        skippedSteps: steps.length - results.length,
        steps: results,
      },
      images: context.images,
    };
  }

  createTools() {
    const tools = [
      [
        "browser_status",
        {
          definition: {
            name: "browser_status",
            description:
              "Report whether the configured browser endpoint is reachable and how many active sessions are attached.",
            inputSchema: emptyObjectSchema(),
          },
          handler: async () => ({
            serverName: SERVER_NAME,
            serverVersion: SERVER_VERSION,
            ...(await this.browserAdapter.getBrowserStatus()),
          }),
        },
      ],
      [
        "list_tabs",
        {
          definition: {
            name: "list_tabs",
            description:
              "List inspectable page targets exposed by the configured browser adapter.",
            inputSchema: emptyObjectSchema(),
          },
          handler: async () => ({
            tabs: await this.browserAdapter.listTargets(),
          }),
        },
      ],
      [
        "launch_browser",
        {
          definition: {
            name: "launch_browser",
            description:
              "Launch a local debug-enabled browser process that matches the current broker configuration and return launch details plus an optional doctor report. When port, address, userDataDir, and unsafeArgs are all omitted and a browser of this family is already reachable, returns it with reused: true instead of launching, opening url in a new tab if given. On macOS and Linux it never starts a second browser on a profile that is already open. Prefer ensure_browser.",
            inputSchema: launchBrowserInputSchema(
              this.config.browserFamily,
              this.config.enableUnsafeLaunchArgs,
            ),
          },
          handler: async (args) =>
            this.runExclusiveLaunch(async () => {
              const browserFamily = requestedBrowserFamily(
                this.config.browserFamily,
                args.browserFamily,
              );
              // A requested port, address, profile, or flags ask for a
              // specific browser, so only a plain launch may reuse the
              // running one.
              if (
                args.port === undefined &&
                args.address === undefined &&
                args.userDataDir === undefined &&
                args.unsafeArgs === undefined
              ) {
                const { status, available } =
                  await this.probeBrowser(browserFamily);
                if (available) {
                  const tab = shouldCreateBrowserTab(args)
                    ? await this.browserAdapter.createTab(args.url, {
                        browserFamily,
                      })
                    : null;
                  return {
                    browserFamily,
                    launched: false,
                    reused: true,
                    status,
                    tab,
                  };
                }
              }

              return this.launchUnlessPending(browserFamily, {
                config: this.config,
                browserFamily: args.browserFamily,
                url: args.url,
                port: args.port,
                address: args.address,
                userDataDir: args.userDataDir,
                unsafeArgs: args.unsafeArgs,
                waitMs: args.waitMs,
                skipDoctor: args.skipDoctor,
              });
            }),
        },
      ],
      [
        "ensure_browser",
        {
          definition: {
            name: "ensure_browser",
            description:
              "Ensure a compatible browser is reachable through the current broker, reusing a running one when possible. If none answers after three status checks, launch one locally, using the MCP_BROWSER_USER_DATA_DIR profile when set, and optionally open a tab for the requested URL. Will not launch again for 30 seconds while a browser it launched is still starting, and on macOS and Linux never starts a second browser on a profile that is already open.",
            inputSchema: ensureBrowserInputSchema(
              this.config.browserFamily,
              this.config.enableUnsafeLaunchArgs,
            ),
          },
          handler: async (args) =>
            this.runExclusiveLaunch(() => this.ensureBrowser(args)),
        },
      ],
      [
        "list_sessions",
        {
          definition: {
            name: "list_sessions",
            description:
              "List active attached debugging sessions held by this broker.",
            inputSchema: emptyObjectSchema(),
          },
          handler: async () => ({
            sessions: this.browserAdapter.listSessions(),
          }),
        },
      ],
      [
        "new_tab",
        {
          definition: {
            name: "new_tab",
            description:
              "Create a new browser tab and return the resulting target metadata.",
            inputSchema: newTabInputSchema(this.config.browserFamily),
          },
          handler: async (args) =>
            this.browserAdapter.createTab(args.url, {
              browserFamily: args.browserFamily,
            }),
        },
      ],
      [
        "close_tab",
        {
          definition: {
            name: "close_tab",
            description:
              "Close a browser tab by target id. Any attached session for that tab will disconnect.",
            inputSchema: {
              type: "object",
              properties: {
                targetId: {
                  type: "string",
                  description: "Target id returned by list_tabs or new_tab.",
                },
              },
              required: ["targetId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.closeTarget(args.targetId),
        },
      ],
      [
        "attach_tab",
        {
          definition: {
            name: "attach_tab",
            description:
              "Attach to a page target and start buffering console, log, and network events.",
            inputSchema: {
              type: "object",
              properties: {
                targetId: {
                  type: "string",
                  description: "The target id returned by list_tabs.",
                },
              },
              required: ["targetId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.attachToTarget(args.targetId),
        },
      ],
      [
        "detach_tab",
        {
          definition: {
            name: "detach_tab",
            description: "Close an attached debugging session.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "The session id returned by attach_tab.",
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.detachSession(args.sessionId),
        },
      ],
      [
        "get_page_state",
        {
          definition: {
            name: "get_page_state",
            description:
              "Return the current URL, title, ready state, viewport, and scroll positions for an attached page.",
            inputSchema: sessionSchema({}, []),
          },
          handler: async (args) =>
            this.browserAdapter.getPageState(args.sessionId),
        },
      ],
      [
        "compare_page_state",
        {
          definition: {
            name: "compare_page_state",
            description:
              "Compare bounded page state across two attached sessions, useful for cross-browser checks in auto mode.",
            inputSchema: compareSessionsSchema({}, []),
          },
          handler: async (args) => {
            const [pageA, pageB] = await Promise.all([
              this.browserAdapter.getPageState(args.sessionIdA),
              this.browserAdapter.getPageState(args.sessionIdB),
            ]);
            const left = summarizeComparablePageState(pageA);
            const right = summarizeComparablePageState(pageB);
            const fields = {
              browserFamily: compareField(
                left.browserFamily,
                right.browserFamily,
              ),
              url: compareField(left.url, right.url),
              title: compareField(left.title, right.title),
              readyState: compareField(left.readyState, right.readyState),
              visibilityState: compareField(
                left.visibilityState,
                right.visibilityState,
              ),
              viewport: compareField(left.viewport, right.viewport),
              scroll: compareField(left.scroll, right.scroll),
            };

            return {
              matches: Object.values(fields).every((field) => field.equal),
              a: left,
              b: right,
              fields,
            };
          },
        },
      ],
      [
        "compare_selector",
        {
          definition: {
            name: "compare_selector",
            description:
              "Compare a selector across two attached sessions using a bounded element summary.",
            inputSchema: compareSessionsSchema(
              {
                selector: selectorProperty(),
              },
              ["selector"],
            ),
          },
          handler: async (args) => {
            const [elementA, elementB] = await Promise.all([
              this.browserAdapter.inspectElement(
                args.sessionIdA,
                args.selector,
              ),
              this.browserAdapter.inspectElement(
                args.sessionIdB,
                args.selector,
              ),
            ]);
            const left = summarizeComparableElement(elementA);
            const right = summarizeComparableElement(elementB);
            const fields = {
              found: compareField(left.found, right.found),
              tagName: compareField(
                left.tagName ?? null,
                right.tagName ?? null,
              ),
              accessibleName: compareField(
                left.accessibleName ?? null,
                right.accessibleName ?? null,
              ),
              role: compareField(left.role ?? null, right.role ?? null),
              visible: compareField(
                left.visible ?? null,
                right.visible ?? null,
              ),
              disabled: compareField(
                left.disabled ?? null,
                right.disabled ?? null,
              ),
              textContent: compareField(
                left.textContent ?? null,
                right.textContent ?? null,
              ),
            };

            return {
              selector: args.selector,
              matches: Object.values(fields).every((field) => field.equal),
              a: left,
              b: right,
              fields,
            };
          },
        },
      ],
      [
        "wait_for",
        {
          definition: {
            name: "wait_for",
            description:
              "Wait until every given condition holds on an attached session: selector state, selector text (textEquals, textIncludes), exact url, urlIncludes substring, and readyState. Give at least one of selector, url, urlIncludes, or readyState. Polls until the conditions match or timeoutMs passes, then fails with the last observed state. A selector check scrolls the matched element into view on each poll.",
            inputSchema: waitForInputSchema(),
          },
          validate: (args) => {
            normalizeWaitForOptions(args);
          },
          handler: async (args) =>
            this.browserAdapter.waitFor(args.sessionId, {
              selector: args.selector,
              state: args.state,
              url: args.url,
              urlIncludes: args.urlIncludes,
              readyState: args.readyState,
              textEquals: args.textEquals,
              textIncludes: args.textIncludes,
              timeoutMs: args.timeoutMs,
              pollIntervalMs: args.pollIntervalMs,
            }),
        },
      ],
      [
        "get_cookies",
        {
          definition: {
            name: "get_cookies",
            description:
              "Read bounded page-visible cookies for the attached session.",
            inputSchema: sessionSchema({}, []),
          },
          handler: async (args) =>
            this.browserAdapter.getCookies(args.sessionId),
        },
      ],
      [
        "get_storage",
        {
          definition: {
            name: "get_storage",
            description:
              "Read bounded localStorage and sessionStorage entries for the attached session.",
            inputSchema: storageInputSchema(),
          },
          handler: async (args) => {
            const result = await this.browserAdapter.getStorage(args.sessionId);
            if (!args.area || args.area === "all") {
              return result;
            }

            return {
              browserFamily: result.browserFamily,
              storage: {
                [args.area]: result.storage?.[args.area] ?? null,
              },
            };
          },
        },
      ],
      [
        "capture_debug_report",
        {
          definition: {
            name: "capture_debug_report",
            description:
              "Capture a bounded debug bundle with page state, cookies/storage summary, recent console, recent network, and an optional screenshot.",
            inputSchema: captureDebugReportInputSchema(
              this.config.browserFamily,
            ),
          },
          handler: async (args) =>
            this.browserAdapter.captureDebugReport(args.sessionId, {
              consoleLimit: args.consoleLimit,
              networkLimit: args.networkLimit,
              includeScreenshot: args.includeScreenshot,
              screenshotFormat: args.screenshotFormat,
            }),
        },
      ],
      [
        "capture_session_snapshot",
        {
          definition: {
            name: "capture_session_snapshot",
            description:
              "Capture a bounded session snapshot with page state, cookies, and web storage for later bounded restore on the same origin.",
            inputSchema: sessionSchema({}, []),
          },
          handler: async (args) =>
            this.browserAdapter.captureSessionSnapshot(args.sessionId),
        },
      ],
      [
        "restore_session_snapshot",
        {
          definition: {
            name: "restore_session_snapshot",
            description:
              "Restore a bounded session snapshot into the currently attached page context. Restores only page-visible cookies plus localStorage/sessionStorage on the current origin.",
            inputSchema: restoreSessionSnapshotInputSchema(),
          },
          validate: (args) => {
            parseSessionSnapshot(args.snapshot);
          },
          handler: async (args) =>
            this.browserAdapter.restoreSessionSnapshot(
              args.sessionId,
              parseSessionSnapshot(args.snapshot),
              {
                clearStorage: args.clearStorage,
              },
            ),
        },
      ],
      [
        "get_har",
        {
          definition: {
            name: "get_har",
            description:
              "Export a bounded HAR-like summary from buffered network activity for an attached session.",
            inputSchema: sessionWithLimitSchema(),
          },
          handler: async (args) =>
            this.browserAdapter.getHar(args.sessionId, {
              limit: args.limit ?? 50,
            }),
        },
      ],
      [
        "navigate",
        {
          definition: {
            name: "navigate",
            description:
              "Navigate an attached tab to a URL and optionally wait for interactive or complete load state.",
            inputSchema: sessionSchema(
              {
                url: {
                  type: "string",
                  description: "Absolute URL to load.",
                },
                waitUntil: waitUntilProperty(),
              },
              ["url"],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.navigate(args.sessionId, args.url, {
              waitUntil: args.waitUntil,
            }),
        },
      ],
      [
        "reload",
        {
          definition: {
            name: "reload",
            description:
              "Reload the attached tab and optionally ignore cache while waiting for interactive or complete load state.",
            inputSchema: sessionSchema(
              {
                ignoreCache: {
                  type: "boolean",
                  description:
                    "Bypass the HTTP cache for this reload (default false).",
                },
                waitUntil: waitUntilProperty(),
              },
              [],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.reload(args.sessionId, {
              ignoreCache: args.ignoreCache,
              waitUntil: args.waitUntil,
            }),
        },
      ],
      [
        "click",
        {
          definition: {
            name: "click",
            description:
              "Click a single element located by CSS, text=..., role=..., or name=... syntax. Sends real mouse input at the element center and fails if another element covers that point. A JavaScript alert or confirm dialog that this opens is accepted automatically and a prompt is dismissed; get_events reports it as a dialog event. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
            inputSchema: sessionSchema(
              {
                selector: selectorProperty(),
              },
              ["selector"],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.click(args.sessionId, args.selector),
        },
      ],
      [
        "hover",
        {
          definition: {
            name: "hover",
            description:
              "Hover a single element located by CSS, text=..., role=..., or name=... syntax. Moves the real mouse pointer to the element center.",
            inputSchema: sessionSchema(
              {
                selector: selectorProperty(),
              },
              ["selector"],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.hover(args.sessionId, args.selector),
        },
      ],
      [
        "type",
        {
          definition: {
            name: "type",
            description:
              "Type text into an input, textarea, or contenteditable element using real text input, replacing existing content unless clear is false. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
            inputSchema: sessionSchema(
              {
                selector: selectorProperty(),
                text: {
                  type: "string",
                  description:
                    "Text to enter. Each newline is sent as an Enter key press: a line break in a textarea, implicit form submission in a single-line input. Date, time, datetime-local, month, week, color, and range inputs get the value set directly, so pass it in that input's value format (for example 2026-09-27). An empty string with clear empties the field.",
                },
                clear: {
                  type: "boolean",
                  description:
                    "Replace the existing content (default true). When false, the text is inserted at the end of the current content. Ignored for date, time, datetime-local, month, week, color, and range inputs, whose value is always replaced.",
                },
              },
              ["selector", "text"],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.type(args.sessionId, args.selector, args.text, {
              clear: args.clear,
            }),
        },
      ],
      [
        "select",
        {
          definition: {
            name: "select",
            description:
              "Select an option in a native <select> element and fire input and change events. Provide value, label, or both; the first option matching either is selected, and the call fails if none matches. Custom dropdowns built from other elements need click instead. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
            inputSchema: sessionSchema(
              {
                selector: selectorProperty(),
                value: {
                  type: "string",
                  description:
                    "Matches an option whose value attribute or full text equals this string.",
                },
                label: {
                  type: "string",
                  description:
                    "Matches an option whose visible text contains this string (case-sensitive).",
                },
              },
              ["selector"],
            ),
          },
          validate: (args) => {
            if (!args.value && !args.label) {
              throw new Error("select requires either value or label");
            }
          },
          handler: async (args) =>
            this.browserAdapter.select(args.sessionId, args.selector, {
              value: args.value,
              label: args.label,
            }),
        },
      ],
      [
        "press_key",
        {
          definition: {
            name: "press_key",
            description:
              "Press a key or key combination (for example Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a) with real keyboard input on the focused element, or on selector after focusing it. Fails if selector cannot take focus. A JavaScript alert or confirm dialog that this opens is accepted automatically and a prompt is dismissed; get_events reports it as a dialog event. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
            inputSchema: sessionSchema(
              {
                key: {
                  type: "string",
                  description:
                    "A single character, or a named key: Enter, Tab, Escape, Backspace, Delete, Insert, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, F1-F12, Shift, Control, Alt, or Meta. Join modifiers with + (Shift+Tab, Control+Enter, Meta+a). Names are case-insensitive; unknown names are rejected.",
                },
                selector: selectorProperty(),
              },
              ["key"],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.pressKey(
              args.sessionId,
              args.key,
              args.selector,
            ),
        },
      ],
      [
        "scroll",
        {
          definition: {
            name: "scroll",
            description:
              "Scroll the page by deltas or scroll a specific element into view.",
            inputSchema: sessionSchema(
              {
                selector: selectorProperty(),
                deltaX: {
                  type: "integer",
                  description:
                    "Horizontal scroll distance in CSS pixels; negative scrolls left. Ignored when selector is given.",
                },
                deltaY: {
                  type: "integer",
                  description:
                    "Vertical scroll distance in CSS pixels; negative scrolls up. Ignored when selector is given.",
                },
                block: {
                  type: "string",
                  enum: ["start", "center", "end", "nearest"],
                  description:
                    "Vertical alignment when scrolling selector into view (default center).",
                },
              },
              [],
            ),
          },
          validate: (args) => {
            if (
              !args.selector &&
              args.deltaX === undefined &&
              args.deltaY === undefined
            ) {
              throw new Error(
                "scroll requires either selector or deltaX/deltaY values",
              );
            }
          },
          handler: async (args) =>
            this.browserAdapter.scroll(args.sessionId, {
              selector: args.selector,
              deltaX: args.deltaX,
              deltaY: args.deltaY,
              block: args.block,
            }),
        },
      ],
      [
        "set_viewport",
        {
          definition: {
            name: "set_viewport",
            description:
              "Override the page viewport to a specific width and height for responsive debugging.",
            inputSchema: sessionSchema(
              {
                width: {
                  type: "integer",
                  minimum: 1,
                  description: "Viewport width in CSS pixels.",
                },
                height: {
                  type: "integer",
                  minimum: 1,
                  description: "Viewport height in CSS pixels.",
                },
                deviceScaleFactor: {
                  type: "number",
                  minimum: 0.1,
                  description:
                    "Device pixel ratio to emulate. Chromium and Edge use 1 when omitted; Firefox keeps its current ratio.",
                },
                mobile: {
                  type: "boolean",
                  description:
                    "Emulate a mobile device, including meta viewport handling (default false). Chromium and Edge only; ignored on Firefox.",
                },
              },
              ["width", "height"],
            ),
          },
          handler: async (args) =>
            this.browserAdapter.setViewport(args.sessionId, {
              width: args.width,
              height: args.height,
              deviceScaleFactor: args.deviceScaleFactor,
              mobile: args.mobile,
            }),
        },
      ],
      [
        "get_console_messages",
        {
          definition: {
            name: "get_console_messages",
            description:
              "Read buffered console, log, and exception messages for an attached session.",
            inputSchema: sessionWithLimitSchema(),
          },
          handler: async (args) => ({
            messages: this.browserAdapter.getConsoleMessages(
              args.sessionId,
              args.limit ?? 50,
            ),
          }),
        },
      ],
      [
        "get_network_requests",
        {
          definition: {
            name: "get_network_requests",
            description:
              "Summarize buffered network requests for an attached session in a DevTools-network-tab style view.",
            inputSchema: sessionWithLimitSchema(),
          },
          handler: async (args) => ({
            requests: this.browserAdapter.getNetworkRequests(
              args.sessionId,
              args.limit ?? 50,
            ),
          }),
        },
      ],
      [
        "get_document",
        {
          definition: {
            name: "get_document",
            description: "Fetch the DOM document tree for an attached page.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "Session id returned by attach_tab.",
                },
                depth: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "How many levels of child nodes to include (default 2). Chromium and Edge only; Firefox returns the full document HTML regardless.",
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.getDocument(args.sessionId, args.depth ?? 2),
        },
      ],
      [
        "inspect_element",
        {
          definition: {
            name: "inspect_element",
            description:
              "Inspect a single DOM element located by CSS, text=..., role=..., or name=... syntax and return normalized element details. Scrolls the element into view first, so the returned box reflects the scrolled position.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "Session id returned by attach_tab.",
                },
                selector: selectorProperty(),
              },
              required: ["sessionId", "selector"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.inspectElement(args.sessionId, args.selector),
        },
      ],
      [
        "take_screenshot",
        {
          definition: {
            name: "take_screenshot",
            description:
              "Capture a screenshot from an attached page or a single element when selector is provided. By default the image comes back as base64 data in the JSON result; output image returns it as image content instead, and output file (or path) writes it to a file and returns the path.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "Session id returned by attach_tab.",
                },
                format: {
                  type: "string",
                  enum: screenshotFormatsFor(this.config.browserFamily),
                  description:
                    "Image format (default png). With path, it must match the extension.",
                },
                selector: selectorProperty(),
                output: {
                  type: "string",
                  enum: ["data", "image", "file"],
                  description:
                    "How to return the image: data puts base64 data in the JSON result, image returns an image content block with only metadata in the JSON, file writes the decoded image to a file and returns its path (default data, or file when path is given).",
                },
                path: {
                  type: "string",
                  description: `Absolute file path for output file, ending in ${screenshotFileExtensions(this.config.browserFamily).join(", ")}; the extension sets the format. Missing parent directories are created. Default: a new file in a private directory under the system temp directory.`,
                },
                overwrite: {
                  type: "boolean",
                  description:
                    "For output file: replace path if it already exists (default false: fail instead).",
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          validate: (args) => {
            screenshotTarget(args, this.config.browserFamily);
          },
          handler: async (args) => this.takeScreenshot(args),
          formatResult: (result, args) => {
            if (args.output !== "image") {
              return asToolResult(result);
            }
            const images = [];
            const value = moveScreenshotImage(result, images);
            return asImageToolResult({ value, images });
          },
        },
      ],
      [
        "get_events",
        {
          definition: {
            name: "get_events",
            description:
              "Read buffered console, log, exception, and network events for an attached session.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "Session id returned by attach_tab.",
                },
                limit: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "Return the most recent N events from the session buffer (default 50).",
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) => ({
            events: this.browserAdapter.getEvents(
              args.sessionId,
              args.limit ?? 50,
            ),
          }),
        },
      ],
    ];

    if (this.config.enableEvaluate) {
      tools.push([
        "evaluate_js",
        {
          definition: {
            name: "evaluate_js",
            description: "Evaluate JavaScript in the attached page context.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "Session id returned by attach_tab.",
                },
                expression: {
                  type: "string",
                  description:
                    "JavaScript expression to evaluate in the page's main world.",
                },
                awaitPromise: {
                  type: "boolean",
                  description:
                    "Wait for a returned promise to settle and return its result (default true).",
                },
                returnByValue: {
                  type: "boolean",
                  description:
                    "Return the result as a JSON value (default true). When false, only a short description of the resulting object is returned. Chromium and Edge only; Firefox always returns a serialized value.",
                },
              },
              required: ["sessionId", "expression"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.evaluate(args.sessionId, args.expression, {
              awaitPromise: args.awaitPromise,
              returnByValue: args.returnByValue,
            }),
        },
      ]);
    }

    const stepTools = tools
      .filter(([, tool]) =>
        tool.definition.inputSchema.required?.includes("sessionId"),
      )
      .map(([name]) => name);
    this.stepSchema = stepSchema(stepTools);
    tools.push([
      "run_steps",
      {
        definition: {
          name: "run_steps",
          description:
            'Run several tools on one attached session in order, in a single call. Use it to act and check the result together, for example [{"tool":"click","arguments":{"selector":"text=Save"}},{"tool":"sleep","arguments":{"ms":300}},{"tool":"take_screenshot"}]. Each step names a tool that takes sessionId (or sleep) and gives that tool\'s arguments without sessionId. To branch on the page state, use an if step, for example {"tool":"if","arguments":{"condition":{"selector":"#status","textIncludes":"failed"},"then":[{"tool":"click","arguments":{"selector":"text=Retry"}}],"elseIf":[{"condition":{"urlIncludes":"/login"},"then":[{"tool":"take_screenshot","arguments":{"output":"image"}}]}],"else":[]}}; conditions are checked once, in order, without waiting, so put wait_for or sleep before the if when the page may still be changing. The if result reports the branch taken (then, elseIf[i], or else), each checked condition with what was observed, and the branch\'s step results. Every step, including both branches, is validated before any runs. A step fails when its tool throws or reports found: false (except inspect_element). Stops at the first failing step unless continueOnError is true, and returns each step\'s result or error. Screenshots come back as image content; the step result keeps the metadata plus image, the 1-based position of its image. Prefer wait_for over sleep when there is a condition to wait for.',
          inputSchema: runStepsInputSchema(stepTools),
        },
        handler: async (args) => this.runSteps(args),
        formatResult: asImageToolResult,
      },
    ]);

    return new Map(tools);
  }

  start() {
    let sawInput = false;

    this.input.on("data", (chunk) => {
      sawInput = true;
      if (this.config.debugStdio) {
        this.logger.log(
          "debug",
          `stdin chunk bytes=${chunk.length} preview="${formatChunkPreview(chunk)}"`,
          { force: true },
        );
      }

      let messages;
      try {
        messages = this.messageBuffer.push(chunk);
      } catch (error) {
        this.logger.error(`failed to parse incoming message: ${error.message}`);
        return;
      }

      for (const message of messages) {
        void this.dispatch(message);
      }
    });

    if (this.config.debugStdio) {
      this.input.on("end", () => {
        this.logger.log("debug", `stdin ended after_input=${sawInput}`, {
          force: true,
        });
      });

      this.input.on("close", () => {
        this.logger.log("debug", `stdin closed after_input=${sawInput}`, {
          force: true,
        });
      });
    }

    if (typeof this.input.resume === "function") {
      this.input.resume();
    }

    this.logger.info(
      `listening on stdio for MCP messages; browser=${this.config.browserFamily}`,
    );
  }

  async dispatch(message) {
    const response = await this.handleRequest(message);
    if (!response) {
      return;
    }

    this.output.write(
      encodeMessage(
        response,
        this.messageBuffer.transportMode ?? "content-length",
      ),
    );
  }

  async handleRequest(message) {
    const id = message?.id ?? null;

    if (message?.jsonrpc !== "2.0") {
      return failure(id, -32600, "Invalid Request");
    }

    try {
      switch (message.method) {
        case "initialize":
          return success(id, {
            protocolVersion: this.config.protocolVersion,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
            instructions:
              "Use the browser tools to inspect tabs, console output, network activity, DOM structure, element state, screenshots, and page interactions across Chromium CDP or Firefox BiDi. To act on a page and check the result, prefer run_steps: put the action, a wait_for, and the check (take_screenshot with output image, inspect_element, or an if step when the page can be in more than one state) in one call instead of several round trips.",
          });
        case "notifications/initialized":
          return null;
        case "ping":
          return success(id, {});
        case "tools/list":
          return success(id, {
            tools: Array.from(this.tools.values(), (tool) => tool.definition),
          });
        case "tools/call":
          return success(id, await this.callTool(message.params));
        default:
          if (message.id === undefined) {
            return null;
          }
          return failure(id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return failure(id, -32000, error.message);
    }
  }

  async callTool(params = {}) {
    const startedAt = Date.now();
    let response = null;
    try {
      const tool = this.tools.get(params.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${params.name}`);
      }

      const args = params.arguments ?? {};
      validateValue("arguments", args, tool.definition.inputSchema);
      tool.validate?.(args);
      const result = await tool.handler(args);
      response = (tool.formatResult ?? asToolResult)(result, args);
      return response;
    } finally {
      await this.logTiming(params.name, startedAt, response);
    }
  }

  // Appends one JSON line per tool call when MCP_BROWSER_TIMING_LOG is set.
  // responseChars and images approximate what the call costs the client.
  async logTiming(name, startedAt, response) {
    if (!this.config.timingLogFile) {
      return;
    }

    const content = response?.content ?? [];
    const entry = {
      ts: new Date(startedAt).toISOString(),
      tool: name ?? null,
      ms: Date.now() - startedAt,
      ok: response !== null,
      responseChars: content
        .filter((block) => block.type === "text")
        .reduce((total, block) => total + block.text.length, 0),
      images: content.filter((block) => block.type === "image").length,
    };
    // ok is whether the call returned; a batch that stopped at a failing
    // step still returns, so its own outcome is logged as stepsOk.
    if (name === "run_steps" && response?.structuredContent) {
      entry.steps = response.structuredContent.ranSteps;
      entry.stepsOk = response.structuredContent.ok;
    }

    try {
      await appendFile(this.config.timingLogFile, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      this.logger.error(`failed to write timing log: ${error.message}`);
    }
  }
}
