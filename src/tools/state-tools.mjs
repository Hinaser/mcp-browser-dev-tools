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
            "Return the current URL, title, ready state, viewport, and scroll positions for an attached page.",
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
            "Compare bounded page state across two attached sessions, useful for cross-browser checks in auto mode.",
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
          description: server.config.enableEvaluate
            ? "Wait until every given condition holds: selector state, its text (textEquals, textIncludes, textExcludes), url, urlIncludes, readyState, or expression; or give anyOf to end on the first of several. Polls until they hold or timeoutMs passes, then fails with the last observed state. Selector checks scroll the element into view."
            : "Wait until every given condition holds: selector state, its text (textEquals, textIncludes, textExcludes), url, urlIncludes, or readyState; or give anyOf to end on the first of several. Polls until they hold or timeoutMs passes, then fails with the last observed state. Selector checks scroll the element into view.",
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
          description:
            "Read bounded page-visible cookies for the attached session.",
          inputSchema: sessionSchema({}, []),
        },
        handler: async (args) =>
          server.browserAdapter.getCookies(args.sessionId),
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
            "Capture a bounded debug bundle with page state, cookies/storage summary, recent console, recent network, and an optional screenshot.",
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
            "Capture a bounded session snapshot with page state, cookies, and web storage for later bounded restore on the same origin.",
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
            "Restore a bounded session snapshot into the currently attached page context. Restores only page-visible cookies plus localStorage/sessionStorage on the current origin.",
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
          description:
            "Export a bounded HAR-like summary from buffered network activity for an attached session.",
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
