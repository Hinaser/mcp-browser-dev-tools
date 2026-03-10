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
