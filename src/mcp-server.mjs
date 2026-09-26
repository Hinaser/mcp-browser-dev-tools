import { encodeMessage, MessageBuffer } from "./json-rpc-stdio.mjs";
import { createLogger } from "./logger.mjs";
import {
  launchBrowser as launchLocalBrowser,
  supportedLaunchFamilies,
} from "./browser-launch-service.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";

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

function waitForInputSchema() {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      selector: selectorProperty(),
      state: {
        type: "string",
        enum: ["present", "visible", "hidden"],
        description:
          "Selector state to wait for (default visible). present: in the DOM. hidden: absent or not visible. Requires selector.",
      },
      url: {
        type: "string",
        description: "Wait until the page URL equals this string exactly.",
      },
      urlIncludes: {
        type: "string",
        description: "Wait until the page URL contains this string.",
      },
      readyState: {
        type: "string",
        enum: ["interactive", "complete"],
        description:
          "Wait until document.readyState reaches this state or later.",
      },
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
        "Browser profile directory. When omitted, Chromium and Edge get a fresh temporary profile if that browser is already running, and the default profile otherwise.",
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
        "Browser profile directory. When omitted, Chromium and Edge get a fresh temporary profile if that browser is already running, and the default profile otherwise.",
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

  return Boolean(status?.browsers?.[requestedFamily]?.available);
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
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.logger = logger;
    this.messageBuffer = new MessageBuffer();
    this.tools = this.createTools();
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
              "Launch a local debug-enabled browser process that matches the current broker configuration and return launch details plus an optional doctor report.",
            inputSchema: launchBrowserInputSchema(
              this.config.browserFamily,
              this.config.enableUnsafeLaunchArgs,
            ),
          },
          handler: async (args) =>
            this.launchBrowser({
              config: this.config,
              browserFamily: args.browserFamily,
              url: args.url,
              port: args.port,
              address: args.address,
              userDataDir: args.userDataDir,
              unsafeArgs: args.unsafeArgs,
              waitMs: args.waitMs,
              skipDoctor: args.skipDoctor,
            }),
        },
      ],
      [
        "ensure_browser",
        {
          definition: {
            name: "ensure_browser",
            description:
              "Ensure a compatible browser is reachable through the current broker. If needed, launch one locally and optionally open a tab for the requested URL.",
            inputSchema: ensureBrowserInputSchema(
              this.config.browserFamily,
              this.config.enableUnsafeLaunchArgs,
            ),
          },
          handler: async (args) => {
            const browserFamily = requestedBrowserFamily(
              this.config.browserFamily,
              args.browserFamily,
            );
            const currentStatus = await this.browserAdapter.getBrowserStatus();
            const available = isRequestedBrowserAvailable(
              currentStatus,
              this.config.browserFamily,
              browserFamily,
            );
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

              launch = await this.launchBrowser({
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
              status = await this.browserAdapter.getBrowserStatus();
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
              launched: Boolean(launch),
              launch,
              status,
              tab,
            };
          },
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
              "Wait until every given condition holds on an attached session: selector state, exact url, urlIncludes substring, and readyState. Give at least one condition. Polls until the conditions match or timeoutMs passes, then fails with the last observed state. A selector check scrolls the matched element into view on each poll.",
            inputSchema: waitForInputSchema(),
          },
          handler: async (args) => {
            if (
              !args.selector &&
              !args.url &&
              !args.urlIncludes &&
              !args.readyState
            ) {
              throw new Error(
                "wait_for requires at least one of selector, url, urlIncludes, or readyState",
              );
            }

            if (!args.selector && args.state !== undefined) {
              throw new Error("wait_for state requires selector");
            }

            return this.browserAdapter.waitFor(args.sessionId, {
              selector: args.selector,
              state: args.state,
              url: args.url,
              urlIncludes: args.urlIncludes,
              readyState: args.readyState,
              timeoutMs: args.timeoutMs,
              pollIntervalMs: args.pollIntervalMs,
            });
          },
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
          handler: async (args) => {
            let snapshot;
            try {
              snapshot = JSON.parse(args.snapshot);
            } catch {
              throw new Error(
                "restore_session_snapshot snapshot must be valid JSON",
              );
            }

            if (!snapshot || typeof snapshot !== "object") {
              throw new Error(
                "restore_session_snapshot snapshot must decode to an object",
              );
            }

            return this.browserAdapter.restoreSessionSnapshot(
              args.sessionId,
              snapshot,
              {
                clearStorage: args.clearStorage,
              },
            );
          },
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
              "Click a single element located by CSS, text=..., role=..., or name=... syntax. Sends real mouse input at the element center and fails if another element covers that point. A JavaScript alert or confirm dialog that this opens is accepted automatically and a prompt is dismissed; get_events reports it as a dialog event.",
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
              "Type text into an input, textarea, or contenteditable element using real text input, replacing existing content unless clear is false.",
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
              "Select an option in a native <select> element and fire input and change events. Provide value, label, or both; the first option matching either is selected, and the call fails if none matches. Custom dropdowns built from other elements need click instead.",
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
          handler: async (args) => {
            if (!args.value && !args.label) {
              throw new Error("select requires either value or label");
            }

            return this.browserAdapter.select(args.sessionId, args.selector, {
              value: args.value,
              label: args.label,
            });
          },
        },
      ],
      [
        "press_key",
        {
          definition: {
            name: "press_key",
            description:
              "Press a key or key combination (for example Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a) with real keyboard input on the focused element, or on selector after focusing it. Fails if selector cannot take focus. A JavaScript alert or confirm dialog that this opens is accepted automatically and a prompt is dismissed; get_events reports it as a dialog event.",
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
          handler: async (args) => {
            if (
              !args.selector &&
              args.deltaX === undefined &&
              args.deltaY === undefined
            ) {
              throw new Error(
                "scroll requires either selector or deltaX/deltaY values",
              );
            }

            return this.browserAdapter.scroll(args.sessionId, {
              selector: args.selector,
              deltaX: args.deltaX,
              deltaY: args.deltaY,
              block: args.block,
            });
          },
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
              "Capture a screenshot from an attached page or a single element when selector is provided.",
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
                  description: "Image format (default png).",
                },
                selector: selectorProperty(),
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.takeScreenshot(
              args.sessionId,
              args.format ?? "png",
              {
                selector: args.selector,
              },
            ),
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
              "Use the browser tools to inspect tabs, console output, network activity, DOM structure, element state, screenshots, and page interactions across Chromium CDP or Firefox BiDi.",
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
    const tool = this.tools.get(params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${params.name}`);
    }

    const args = params.arguments ?? {};
    validateValue("arguments", args, tool.definition.inputSchema);
    const result = await tool.handler(args);
    return asToolResult(result);
  }
}
