import { DEFAULT_ACTION_TIMEOUT_MS } from "./action-retry.mjs";
import { supportedLaunchFamilies } from "./browser-launch-service.mjs";
import { screenshotFormatsFor } from "./screenshot-output.mjs";

export function emptyObjectSchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

export function sessionWithLimitSchema(description) {
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

export const LOCATOR_DESCRIPTION =
  'Locator: ref=e12 (from get_snapshot), CSS, text=Visible text, role=button[name="Save"], or name=Accessible name.';

// A copy of schema without descriptions, for a schema repeated inside another
// whose fields are already described once; validation is unchanged.
export function withoutDescriptions(schema) {
  if (Array.isArray(schema)) {
    return schema.map(withoutDescriptions);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key, value]) => key !== "description" || typeof value !== "string",
      )
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

export function selectorProperty() {
  return {
    type: "string",
    description: LOCATOR_DESCRIPTION,
  };
}

// x and y place pointer input at viewport coordinates instead of an element.
export function pointProperties(prefix = "") {
  const name = (axis) => (prefix ? prefix + axis.toUpperCase() : axis);
  return {
    [name("x")]: {
      type: "number",
      minimum: 0,
      description: `Viewport x in CSS pixels, with ${name("y")}, instead of ${prefix ? `${prefix}Selector` : "selector"}; a screenshot's cssRect and scale convert image pixels.`,
    },
    [name("y")]: {
      type: "number",
      minimum: 0,
      description: `Viewport y in CSS pixels, with ${name("x")}.`,
    },
  };
}

// The selector, or the { x, y } point, that args name under prefix; throws
// unless exactly one of the two is given.
export function pointerTarget(args, prefix = "", required = true) {
  const key = (name) =>
    prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
  const selector = args[key("selector")];
  const x = args[key("x")];
  const y = args[key("y")];
  const hasPoint = x !== undefined || y !== undefined;
  if (hasPoint && (x === undefined || y === undefined)) {
    throw new Error(`${key("x")} and ${key("y")} go together`);
  }
  if (selector !== undefined && hasPoint) {
    throw new Error(
      `Pass ${key("selector")} or ${key("x")}/${key("y")}, not both`,
    );
  }
  if (selector === undefined && !hasPoint) {
    if (!required) {
      return null;
    }
    throw new Error(`Pass ${key("selector")} or ${key("x")} and ${key("y")}`);
  }
  return selector ?? { x, y };
}

export function sessionSchema(properties, required, description) {
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

export function waitUntilProperty() {
  return {
    type: "string",
    enum: ["none", "interactive", "complete"],
    description:
      "When to return: none returns once navigation starts, interactive after DOMContentLoaded, complete after the load event (default complete).",
  };
}

// With expression, conditions also take a JavaScript expression; it is left
// out when evaluate_js is turned off.
export function pageConditionProperties({ expression = false } = {}) {
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
        "The selector's full visible text equals this, with whitespace collapsed. Requires selector; not with state hidden.",
    },
    textIncludes: {
      type: "string",
      description:
        "The selector's full visible text contains this, with whitespace collapsed. Requires selector; not with state hidden.",
    },
    textExcludes: {
      type: "string",
      description:
        "The selector's visible text no longer contains this, for example Processing; never holds for a missing element. Requires selector; not with state hidden.",
    },
    ...(expression
      ? {
          expression: {
            type: "string",
            description:
              "JavaScript in the page's main world; holds when its result (awaited if a promise) is truthy, for example document.querySelectorAll('.row').length >= 5. Throwing fails the check; each evaluation must settle within the remaining wait (5000ms in if and repeat).",
          },
        }
      : {}),
  };
}

export function conditionSchema(options) {
  return {
    type: "object",
    properties: {
      ...pageConditionProperties(options),
      anyOf: anyOfProperty(options),
    },
    additionalProperties: false,
  };
}

export function anyOfProperty(options) {
  return {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: withoutDescriptions(pageConditionProperties(options)),
      additionalProperties: false,
    },
    description:
      "Alternative conditions with the fields above, instead of them; holds when any one holds, checked in order, for example a status of either Paid or Declined. The result reports matchedIndex.",
  };
}

export function waitForInputSchema(options) {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id returned by attach_tab.",
      },
      ...pageConditionProperties(options),
      anyOf: anyOfProperty(options),
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

export function actionTimeoutProperty(what) {
  return {
    type: "integer",
    minimum: 0,
    maximum: 30_000,
    description: `How long to keep retrying while the element is missing${what}, before failing (default ${DEFAULT_ACTION_TIMEOUT_MS}; 0 fails at once).`,
  };
}

export function compareSessionsSchema(properties, required) {
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

export function storageInputSchema() {
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

export function captureDebugReportInputSchema(browserFamily) {
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

export function restoreSessionSnapshotInputSchema() {
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

export function newTabInputSchema(browserFamily) {
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

export function unsafeArgsProperty() {
  return {
    type: "array",
    items: {
      type: "string",
    },
    description:
      "Extra browser command-line flags, each starting with -. Flags that conflict with broker-managed launch options (debugging port, address, profile) are rejected.",
  };
}

export function launchBrowserInputSchema(
  browserFamily,
  enableUnsafeLaunchArgs,
) {
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
        "Profile directory for a new launch (default: MCP_BROWSER_USER_DATA_DIR). Without either, Chromium and Edge use a temporary profile if already running, else the default one.",
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

export function ensureBrowserInputSchema(
  browserFamily,
  enableUnsafeLaunchArgs,
) {
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
        "Profile directory for a new launch (default: MCP_BROWSER_USER_DATA_DIR). Without either, Chromium and Edge use a temporary profile if already running, else the default one.",
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
