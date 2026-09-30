import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { ELEMENT_NOT_ACTIONABLE } from "./page-context.mjs";

export function createFakeManager() {
  return {
    async getBrowserStatus() {
      return { available: true };
    },
    async listTargets() {
      return [
        { targetId: "tab-1", title: "Example", url: "https://example.com" },
      ];
    },
    listSessions() {
      return [{ sessionId: "session-1", targetId: "tab-1" }];
    },
    async createTab(url = "about:blank", options = {}) {
      return {
        targetId: "tab-2",
        url,
        browserFamily: options.browserFamily ?? "chromium",
      };
    },
    async closeTarget(targetId) {
      return {
        targetId,
        closed: true,
        detachedSessions: [{ sessionId: "session-1" }],
      };
    },
    async attachToTarget(targetId) {
      return { sessionId: "session-2", targetId };
    },
    async detachSession(sessionId) {
      return { detached: true, sessionId };
    },
    async getPageState(sessionId) {
      return {
        sessionId,
        url: "https://example.com/dashboard",
        viewport: { width: 1280, height: 720 },
        readyState: "complete",
      };
    },
    async waitFor(sessionId, options) {
      return {
        sessionId,
        matched: true,
        condition: options,
      };
    },
    async navigate(sessionId, url, options) {
      return { sessionId, url, waitUntil: options.waitUntil ?? "complete" };
    },
    async reload(sessionId, options) {
      return {
        sessionId,
        url: "https://example.com/dashboard",
        ignoreCache: options.ignoreCache ?? false,
      };
    },
    async getCookies(sessionId) {
      return {
        sessionId,
        cookies: {
          totalEntries: 1,
          returnedEntries: 1,
          truncated: false,
          entries: [{ name: "sid", value: "abc123" }],
          source: "document.cookie",
        },
      };
    },
    async getStorage(sessionId) {
      return {
        sessionId,
        storage: {
          localStorage: {
            type: "localStorage",
            totalEntries: 1,
            returnedEntries: 1,
            truncated: false,
            entries: [{ key: "theme", value: "light" }],
          },
          sessionStorage: {
            type: "sessionStorage",
            totalEntries: 0,
            returnedEntries: 0,
            truncated: false,
            entries: [],
          },
        },
      };
    },
    async captureDebugReport(sessionId, options) {
      return {
        sessionId,
        capturedAt: "2026-03-11T00:00:00.000Z",
        page: {
          url: "https://example.com/dashboard",
          title: "Dashboard",
        },
        cookies: {
          totalEntries: 1,
          sampleNames: ["sid"],
        },
        storage: {
          localStorage: {
            totalEntries: 1,
            sampleKeys: ["theme"],
          },
        },
        console: [{ kind: "console", text: "hello" }],
        network: [{ requestId: "req-1", url: "https://example.com/api" }],
        screenshot:
          options.includeScreenshot === false ? null : { format: "png" },
      };
    },
    async captureSessionSnapshot(sessionId) {
      return {
        sessionId,
        capturedAt: "2026-03-11T00:00:00.000Z",
        page: {
          url: "https://example.com/dashboard",
          title: "Dashboard",
        },
        cookies: {
          entries: [{ name: "sid", value: "abc123" }],
        },
        storage: {
          localStorage: {
            entries: [{ key: "theme", value: "light" }],
          },
          sessionStorage: {
            entries: [],
          },
        },
      };
    },
    async restoreSessionSnapshot(sessionId, snapshot, options) {
      return {
        sessionId,
        restoredAt: "2026-03-11T00:00:00.000Z",
        snapshot,
        clearStorage: options.clearStorage ?? false,
      };
    },
    getHar(sessionId, options) {
      return {
        sessionId,
        limit: options.limit,
        log: {
          version: "1.2",
          entries: [],
        },
      };
    },
    async click(sessionId, selector) {
      return { sessionId, selector, clicked: true };
    },
    async hover(sessionId, selector) {
      return { sessionId, selector, hovered: true };
    },
    async type(sessionId, selector, text, options) {
      return {
        sessionId,
        selector,
        typedText: text,
        clear: options.clear ?? true,
      };
    },
    async select(sessionId, selector, options) {
      return {
        sessionId,
        selector,
        selectedValue: options.value ?? null,
        selectedLabel: options.label ?? null,
      };
    },
    async pressKey(sessionId, key, selector) {
      return { sessionId, key, selector: selector ?? null, dispatched: true };
    },
    async scroll(sessionId, options) {
      return { sessionId, ...options, scrolled: true };
    },
    async setViewport(sessionId, options) {
      return { sessionId, applied: true, viewport: options };
    },
    async evaluate(sessionId, expression) {
      return { sessionId, result: expression };
    },
    async getDocument(sessionId, depth) {
      return { sessionId, depth, root: { nodeName: "HTML" } };
    },
    getConsoleMessages(sessionId, limit) {
      return [{ sessionId, limit, kind: "console", text: "hello" }];
    },
    getNetworkRequests(sessionId, limit) {
      return [
        { sessionId, limit, requestId: "req-1", url: "https://example.com" },
      ];
    },
    async inspectElement(sessionId, selector) {
      return { sessionId, selector, found: true, node: { nodeName: "DIV" } };
    },
    async takeScreenshot(sessionId, format, options) {
      return {
        sessionId,
        format,
        selector: options.selector ?? null,
        data: "ZmFrZQ==",
      };
    },
    getEvents(sessionId, limit) {
      return [{ sessionId, limit, method: "Runtime.consoleAPICalled" }];
    },
  };
}

export function createLaunchServer({ chromiumAvailable, launches }) {
  const browserAdapter = createFakeManager();
  browserAdapter.getBrowserStatus = async () => {
    const available = chromiumAvailable();
    return {
      available,
      browserFamily: "auto",
      browsers: {
        chromium: { available },
        firefox: { available: false },
      },
    };
  };

  return new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter,
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      launches.push(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { browserFamily: args.browserFamily, launched: true };
    },
  });
}

export function callTool(server, name, args, id = 1) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

export function callRunSteps(server, args) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id: 90,
    method: "tools/call",
    params: {
      name: "run_steps",
      arguments: args,
    },
  });
}

export function createBranchingManager(elements) {
  const manager = createFakeManager();
  const calls = [];
  manager.inspectElement = async (sessionId, selector) =>
    elements[selector]
      ? {
          selector,
          found: true,
          node: { visible: true, ...elements[selector] },
        }
      : { selector, found: false };
  manager.click = async (sessionId, selector) => {
    calls.push(`click ${selector}`);
    return { selector, found: true };
  };
  return { manager, calls };
}

export function createPaymentManager(approveOnAttempt) {
  const manager = createFakeManager();
  const calls = [];
  let attempts = 0;
  manager.click = async (sessionId, selector) => {
    calls.push(`click ${selector}`);
    if (selector === "#missing") {
      return { selector, found: false };
    }
    if (selector === "#pay") {
      attempts += 1;
    }
    return { selector, found: true };
  };
  manager.inspectElement = async (sessionId, selector) => ({
    selector,
    found: true,
    node: {
      visible: true,
      innerText: attempts === approveOnAttempt ? "Paid" : "Declined",
    },
  });
  return { manager, calls };
}

export function notActionable(message) {
  const error = new Error(message);
  error.code = ELEMENT_NOT_ACTIONABLE;
  return error;
}

export function createFlakyClickManager(outcomes) {
  const manager = createFakeManager();
  const calls = [];
  manager.click = async (sessionId, selector) => {
    const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)];
    calls.push(selector);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { selector, ...outcome };
  };
  return { manager, calls };
}
