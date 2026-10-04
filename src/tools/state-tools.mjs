import {
  captureDebugReportInputSchema,
  compareSessionsSchema,
  restoreSessionSnapshotInputSchema,
  selectorProperty,
  sessionSchema,
  sessionWithLimitSchema,
  storageInputSchema,
  waitForInputSchema,
} from "../tool-schemas.mjs";
import { normalizeWaitForOptions } from "../wait-for.mjs";

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

export function stateTools(server) {
  return [
    [
      "get_page_state",
      {
        definition: {
          name: "get_page_state",
          description:
            "URL, title, ready state, viewport, and scroll position.",
          inputSchema: sessionSchema({}, []),
        },
        handler: async (args) =>
          server.browserAdapter.getPageState(args.sessionId),
      },
    ],
    [
      "compare_page_state",
      {
        definition: {
          name: "compare_page_state",
          description:
            "Compare page state across two sessions, for cross-browser checks.",
          inputSchema: compareSessionsSchema({}, []),
        },
        handler: async (args) => {
          const [pageA, pageB] = await Promise.all([
            server.browserAdapter.getPageState(args.sessionIdA),
            server.browserAdapter.getPageState(args.sessionIdB),
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
          description: "Compare one element across two sessions.",
          inputSchema: compareSessionsSchema(
            {
              selector: selectorProperty(),
            },
            ["selector"],
          ),
        },
        handler: async (args) => {
          const [elementA, elementB] = await Promise.all([
            server.browserAdapter.inspectElement(
              args.sessionIdA,
              args.selector,
            ),
            server.browserAdapter.inspectElement(
              args.sessionIdB,
              args.selector,
            ),
          ]);
          const left = summarizeComparableElement(elementA);
          const right = summarizeComparableElement(elementB);
          const fields = {
            found: compareField(left.found, right.found),
            tagName: compareField(left.tagName ?? null, right.tagName ?? null),
            accessibleName: compareField(
              left.accessibleName ?? null,
              right.accessibleName ?? null,
            ),
            role: compareField(left.role ?? null, right.role ?? null),
            visible: compareField(left.visible ?? null, right.visible ?? null),
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
            "Wait until every given condition holds, or the first of anyOf; at timeoutMs it fails with the last observed state. Selector checks scroll the element into view.",
          inputSchema: waitForInputSchema({
            expression: server.config.enableEvaluate,
          }),
        },
        validate: (args) => {
          normalizeWaitForOptions(args);
        },
        handler: async (args) =>
          server.browserAdapter.waitFor(args.sessionId, {
            selector: args.selector,
            state: args.state,
            url: args.url,
            urlIncludes: args.urlIncludes,
            readyState: args.readyState,
            textEquals: args.textEquals,
            textIncludes: args.textIncludes,
            textExcludes: args.textExcludes,
            expression: args.expression,
            anyOf: args.anyOf,
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
          description: "Page-visible cookies.",
          inputSchema: sessionSchema({}, []),
        },
        handler: async (args) =>
          server.browserAdapter.getCookies(args.sessionId),
      },
    ],
    [
      "set_network",
      {
        definition: {
          name: "set_network",
          description:
            "Block or mock requests by URL glob (* any run, ? one character), add request headers, or emulate offline and slow networks (throttling Chromium only). A call replaces the fields it gives; reset clears all. Returns the rules with their hits.",
          inputSchema: sessionSchema(
            {
              rules: {
                type: "array",
                maxItems: 50,
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string", description: "e.g. *://*/api/ads*" },
                    action: { type: "string", enum: ["block", "mock"] },
                    status: { type: "integer", minimum: 100, maximum: 599 },
                    contentType: { type: "string" },
                    body: { type: "string" },
                    headers: {
                      type: "object",
                      additionalProperties: { type: "string" },
                    },
                  },
                  required: ["url", "action"],
                  additionalProperties: false,
                },
                description:
                  "First match wins; [] clears. Mock status defaults to 200.",
              },
              headers: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Extra request headers; {} clears.",
              },
              offline: { type: "boolean" },
              latencyMs: { type: "integer", minimum: 0 },
              downloadKbps: { type: "number", exclusiveMinimum: 0 },
              uploadKbps: { type: "number", exclusiveMinimum: 0 },
              reset: { type: "boolean" },
            },
            [],
          ),
        },
        handler: async (args) => {
          const { sessionId, ...options } = args;
          return server.browserAdapter.setNetwork(sessionId, options);
        },
      },
    ],
    [
      "get_storage",
      {
        definition: {
          name: "get_storage",
          description: "localStorage and sessionStorage entries.",
          inputSchema: storageInputSchema(),
        },
        handler: async (args) => {
          const result = await server.browserAdapter.getStorage(args.sessionId);
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
            "One bundle: page state, cookie and storage summary, recent console and network, and a screenshot.",
          inputSchema: captureDebugReportInputSchema(
            server.config.browserFamily,
          ),
        },
        handler: async (args) =>
          server.browserAdapter.captureDebugReport(args.sessionId, {
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
            "Save page state, cookies, and web storage for restore_session_snapshot on the same origin.",
          inputSchema: sessionSchema({}, []),
        },
        handler: async (args) =>
          server.browserAdapter.captureSessionSnapshot(args.sessionId),
      },
    ],
    [
      "restore_session_snapshot",
      {
        definition: {
          name: "restore_session_snapshot",
          description:
            "Restore page-visible cookies and web storage from capture_session_snapshot, on the current origin.",
          inputSchema: restoreSessionSnapshotInputSchema(),
        },
        validate: (args) => {
          parseSessionSnapshot(args.snapshot);
        },
        handler: async (args) =>
          server.browserAdapter.restoreSessionSnapshot(
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
          description: "Buffered network activity as a HAR-like summary.",
          inputSchema: sessionWithLimitSchema(),
        },
        handler: async (args) =>
          server.browserAdapter.getHar(args.sessionId, {
            limit: args.limit ?? 50,
          }),
      },
    ],
  ];
}
