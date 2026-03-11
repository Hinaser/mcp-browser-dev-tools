import assert from "node:assert/strict";
import test from "node:test";

import { CdpSession, CdpSessionManager } from "./cdp-client.mjs";

test("CdpSession getSummary reports the configured browser family", () => {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    {
      config: {
        browserFamily: "edge",
      },
    },
  );

  const summary = session.getSummary();
  assert.equal(summary.browserFamily, "edge");
});

test("CdpSessionManager attachToTarget propagates config into session summaries", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "edge",
    cdpBaseUrl: "http://127.0.0.1:9223",
    eventBufferSize: 200,
  });
  manager.fetchJson = async () => [
    {
      id: "target-1",
      type: "page",
      title: "Example",
      url: "https://example.com",
      attached: false,
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
  ];

  const originalConnect = CdpSession.prototype.connect;
  CdpSession.prototype.connect = async function mockConnect() {
    return this.getSummary();
  };

  try {
    const summary = await manager.attachToTarget("target-1");
    assert.equal(summary.browserFamily, "edge");
    assert.equal(summary.targetId, "target-1");
  } finally {
    CdpSession.prototype.connect = originalConnect;
  }
});

test("CdpSessionManager createTab returns the created target metadata", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "chromium",
    cdpBaseUrl: "http://127.0.0.1:9222",
    eventBufferSize: 200,
  });

  manager.sendBrowserCommand = async (method, params) => {
    assert.equal(method, "Target.createTarget");
    assert.equal(params.url, "https://example.com/docs");
    return { targetId: "target-2" };
  };
  manager.listTargets = async () => [
    {
      targetId: "target-2",
      type: "page",
      title: "Docs",
      url: "https://example.com/docs",
      attached: false,
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-2",
    },
  ];

  const target = await manager.createTab("https://example.com/docs");

  assert.equal(target.browserFamily, "chromium");
  assert.equal(target.targetId, "target-2");
  assert.equal(target.title, "Docs");
});

test("CdpSessionManager closeTarget removes attached sessions for the closed tab", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "chromium",
    cdpBaseUrl: "http://127.0.0.1:9222",
    eventBufferSize: 200,
  });

  const affectedSession = {
    id: "session-1",
    target: { targetId: "target-1" },
    markClosedCalled: false,
    markClosed() {
      this.markClosedCalled = true;
    },
  };
  manager.sessions.set(affectedSession.id, affectedSession);
  manager.sessions.set("session-2", {
    id: "session-2",
    target: { targetId: "target-2" },
    markClosed() {},
  });

  manager.sendBrowserCommand = async (method, params) => {
    assert.equal(method, "Target.closeTarget");
    assert.equal(params.targetId, "target-1");
    return { success: true };
  };

  const result = await manager.closeTarget("target-1");

  assert.equal(result.closed, true);
  assert.deepEqual(result.detachedSessions, [{ sessionId: "session-1" }]);
  assert.equal(affectedSession.markClosedCalled, true);
  assert.equal(manager.sessions.has("session-1"), false);
  assert.equal(manager.sessions.has("session-2"), true);
});

test("CdpSessionManager waitFor resolves when the selector becomes visible", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "chromium",
    cdpBaseUrl: "http://127.0.0.1:9222",
    eventBufferSize: 200,
  });

  let attempt = 0;
  manager.inspectElement = async (_sessionId, selector) => {
    attempt += 1;
    return {
      browserFamily: "chromium",
      selector,
      found: attempt >= 2,
      node: attempt >= 2 ? { visible: true } : null,
    };
  };

  const result = await manager.waitFor("session-1", {
    selector: "#app",
    state: "visible",
    timeoutMs: 50,
    pollIntervalMs: 1,
  });

  assert.equal(result.matched, true);
  assert.equal(result.element.selector, "#app");
  assert.equal(result.element.found, true);
  assert.equal(result.attempts, 2);
});

test("CdpSessionManager auto-discovers a loopback CDP endpoint when using the default port", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "edge",
    cdpBaseUrl: "http://127.0.0.1:9222",
    eventBufferSize: 200,
  });

  manager.fetchJsonAt = async (baseUrl, pathname) => {
    if (pathname === "/json/version") {
      if (baseUrl === "http://127.0.0.1:9222") {
        throw new Error("connection refused");
      }

      if (baseUrl === "http://127.0.0.1:9223") {
        return {
          Browser: "Edg/145.0.0.0",
          "Protocol-Version": "1.3",
          "User-Agent": "test-agent",
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/test",
        };
      }
    }

    if (pathname === "/json/list" && baseUrl === "http://127.0.0.1:9223") {
      return [
        {
          id: "target-1",
          type: "page",
          title: "Example",
          url: "https://example.com",
          attached: false,
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-1",
        },
      ];
    }

    throw new Error(`Unexpected request: ${baseUrl}${pathname}`);
  };

  const status = await manager.getBrowserStatus();
  const targets = await manager.listTargets();

  assert.equal(status.available, true);
  assert.equal(status.endpoint, "http://127.0.0.1:9223");
  assert.equal(targets[0].targetId, "target-1");
});

test("CdpSessionManager re-discovers a loopback CDP endpoint when the cached port stops responding", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "chromium",
    cdpBaseUrl: "http://127.0.0.1:9222",
    eventBufferSize: 200,
  });

  let activePort = "9223";
  manager.fetchJsonAt = async (baseUrl, pathname) => {
    const port = new URL(baseUrl).port;
    if (port !== activePort) {
      throw new Error(`connection refused at ${baseUrl}`);
    }

    if (pathname === "/json/version") {
      return {
        Browser: "Chrome/145.0.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "test-agent",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test`,
      };
    }

    if (pathname === "/json/list") {
      return [
        {
          id: `target-${port}`,
          type: "page",
          title: `Example ${port}`,
          url: "https://example.com",
          attached: false,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/target-${port}`,
        },
      ];
    }

    throw new Error(`Unexpected request: ${baseUrl}${pathname}`);
  };

  const initialStatus = await manager.getBrowserStatus();
  activePort = "9224";
  const targets = await manager.listTargets();
  const updatedStatus = await manager.getBrowserStatus();

  assert.equal(initialStatus.endpoint, "http://127.0.0.1:9223");
  assert.equal(targets[0].targetId, "target-9224");
  assert.equal(updatedStatus.endpoint, "http://127.0.0.1:9224");
});

test("CdpSessionManager skips the cached loopback endpoint when only the follow-up request fails", async () => {
  const manager = new CdpSessionManager({
    browserFamily: "chromium",
    cdpBaseUrl: "http://127.0.0.1:9222",
    eventBufferSize: 200,
  });

  manager.fetchJsonAt = async (baseUrl, pathname) => {
    const port = new URL(baseUrl).port;
    if (pathname === "/json/version") {
      if (port === "9222") {
        throw new Error("connection refused");
      }

      return {
        Browser: "Chrome/145.0.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "test-agent",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test`,
      };
    }

    if (pathname === "/json/list") {
      if (port === "9223") {
        throw new Error("stale browser endpoint");
      }

      if (port === "9224") {
        return [
          {
            id: "target-9224",
            type: "page",
            title: "Recovered",
            url: "https://example.com",
            attached: false,
            webSocketDebuggerUrl:
              "ws://127.0.0.1:9224/devtools/page/target-9224",
          },
        ];
      }
    }

    throw new Error(`Unexpected request: ${baseUrl}${pathname}`);
  };

  const initialStatus = await manager.getBrowserStatus();
  const targets = await manager.listTargets();
  const updatedStatus = await manager.getBrowserStatus();

  assert.equal(initialStatus.endpoint, "http://127.0.0.1:9223");
  assert.equal(targets[0].targetId, "target-9224");
  assert.equal(updatedStatus.endpoint, "http://127.0.0.1:9224");
});
