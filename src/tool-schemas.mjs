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
      sessionId: { type: "string" },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Most recent N (default 50).",
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
    description,
  };
}

export const LOCATOR_DESCRIPTION =
  'Locator: ref=e3, CSS, text=\u2026, role=button[name="\u2026"], or name=\u2026';

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
      description: `Viewport CSS px, with ${name("y")}, instead of ${prefix ? `${prefix}Selector` : "selector"}.`,
    },
    [name("y")]: { type: "number", minimum: 0 },
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
      sessionId: { type: "string" },
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
      "Return at none (navigation started), interactive (DOMContentLoaded), or complete (load; default).",
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
        "With selector (default visible); hidden means absent or not visible.",
    },
    url: {
      type: "string",
      description: "Page URL equals this.",
    },
    urlIncludes: {
      type: "string",
      description: "Page URL contains this.",
    },
    readyState: {
      type: "string",
      enum: ["interactive", "complete"],
      description: "document.readyState is at least this.",
    },
    textEquals: {
      type: "string",
      description:
        "The selector's visible text equals this (whitespace collapsed).",
    },
    textIncludes: {
      type: "string",
      description: "The selector's visible text contains this.",
    },
    textExcludes: {
      type: "string",
      description:
        "The selector's visible text no longer contains this; false for a missing element.",
    },
    ...(expression
      ? {
          expression: {
            type: "string",
            description:
              "Page JavaScript; holds when its (awaited) result is truthy. Throwing fails.",
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
      "Conditions with the fields above, instead of them; holds when any holds (result: matchedIndex).",
  };
}

export function waitForInputSchema(options) {
  return {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      ...pageConditionProperties(options),
      anyOf: anyOfProperty(options),
      timeoutMs: {
        type: "integer",
        minimum: 1,
        description: "ms before failing (default 10000).",
      },
      pollIntervalMs: {
        type: "integer",
        minimum: 1,
        description: "ms between checks (default 100).",
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
    description: `ms to retry while the element is missing${what} (default ${DEFAULT_ACTION_TIMEOUT_MS}).`,
  };
}

export function compareSessionsSchema(properties, required) {
  return {
    type: "object",
    properties: {
      sessionIdA: { type: "string" },
      sessionIdB: { type: "string" },
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
      sessionId: { type: "string" },
      area: {
        type: "string",
        enum: ["all", "localStorage", "sessionStorage"],
        description: "Default all.",
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
      sessionId: { type: "string" },
      consoleLimit: {
        type: "integer",
        minimum: 1,
        description: "Default 20.",
      },
      networkLimit: {
        type: "integer",
        minimum: 1,
        description: "Default 20.",
      },
      includeScreenshot: {
        type: "boolean",
        description: "Default true.",
      },
      screenshotFormat: {
        type: "string",
        enum: screenshotFormatsFor(browserFamily),
        description: "Default png.",
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
      sessionId: { type: "string" },
      snapshot: {
        type: "string",
        description: "capture_session_snapshot's JSON output, as a string.",
      },
      clearStorage: {
        type: "boolean",
        description: "Clear web storage first (default false).",
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
      description: "Default about:blank.",
    },
  };
  const required = [];

  if (browserFamily === "auto") {
    properties.browserFamily = {
      type: "string",
      enum: ["chromium", "firefox"],
      description: "Required in auto mode.",
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
      "Extra browser flags; ones that set the port, address, or profile are rejected.",
  };
}

export function launchBrowserInputSchema(
  browserFamily,
  enableUnsafeLaunchArgs,
) {
  const properties = {
    url: {
      type: "string",
      description: "Default about:blank.",
    },
    browserFamily: {
      type: "string",
      enum: supportedLaunchFamilies(browserFamily),
      description: "Required in auto mode.",
    },
    port: {
      type: "integer",
      minimum: 1,
      description:
        "Debugging port (default: the configured endpoint's, usually 9222).",
    },
    address: {
      type: "string",
      description:
        "Chromium/Edge bind address; loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1.",
    },
    userDataDir: {
      type: "string",
      description:
        "Profile for a new launch (default MCP_BROWSER_USER_DATA_DIR).",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      description: "ms to wait for the endpoint after launch (default 5000).",
    },
    skipDoctor: {
      type: "boolean",
      description:
        "Return right after spawning, without waiting or a doctor report.",
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
      description: "Required in auto mode.",
    },
    url: {
      type: "string",
      description: "Open this in a new tab.",
    },
    createTab: {
      type: "boolean",
      description: "Default: true when url is given.",
    },
    launchIfMissing: {
      type: "boolean",
      description: "Launch when none is reachable (default true).",
    },
    port: {
      type: "integer",
      minimum: 1,
      description:
        "Debugging port (default: the configured endpoint's, usually 9222).",
    },
    address: {
      type: "string",
      description:
        "Chromium/Edge bind address; loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1.",
    },
    userDataDir: {
      type: "string",
      description:
        "Profile for a new launch (default MCP_BROWSER_USER_DATA_DIR).",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      description: "ms to wait for the endpoint after launch (default 5000).",
    },
    skipDoctor: {
      type: "boolean",
      description:
        "Return right after spawning, without waiting or a doctor report.",
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
