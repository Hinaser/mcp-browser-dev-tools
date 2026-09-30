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

test("CdpSession auto-dismisses alert dialogs via Page.handleJavaScriptDialog", () => {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );

  const sentCommands = [];
  session.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };

  session.bufferEvent("Page.javascriptDialogOpening", {
    type: "alert",
    message: "Hello!",
  });

  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, "Page.handleJavaScriptDialog");
  assert.equal(sentCommands[0].params.accept, true);

  const dialogEvent = session.bufferedEvents.find(
    (e) => e.kind === "dialog" && e.phase === "opened",
  );
  assert.ok(dialogEvent);
  assert.equal(dialogEvent.dialogType, "alert");
  assert.equal(dialogEvent.message, "Hello!");
});

test("CdpSession auto-dismisses confirm dialogs with accept=true", () => {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );

  const sentCommands = [];
  session.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };

  session.bufferEvent("Page.javascriptDialogOpening", {
    type: "confirm",
    message: "Are you sure?",
  });

  assert.equal(sentCommands[0].params.accept, true);
});

test("CdpSession auto-dismisses prompt dialogs with accept=false", () => {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );

  const sentCommands = [];
  session.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };

  session.bufferEvent("Page.javascriptDialogOpening", {
    type: "prompt",
    message: "Enter value:",
    defaultPrompt: "default",
  });

  assert.equal(sentCommands[0].params.accept, false);
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

function createInputSession(pageActions) {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );

  const sentCommands = [];
  const runActions = [];
  session.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };
  session.runPageAction = async (payload) => {
    runActions.push(payload.action);
    return pageActions[payload.action](payload);
  };

  return { session, sentCommands, runActions };
}

const pointerTarget = (payload) => ({
  found: true,
  selector: payload.selector,
  point: { x: 70, y: 40 },
  receivesEvents: true,
  obscuredBy: null,
  node: { tagName: "BUTTON" },
});

test("CdpSession click dispatches trusted mouse events at the element center", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
  });

  const result = await session.click("button.cta");

  assert.equal(result.clicked, true);
  assert.deepEqual(
    sentCommands.map(({ method, params }) => [
      method,
      params.type,
      params.x,
      params.y,
      params.button,
    ]),
    [
      ["Input.dispatchMouseEvent", "mouseMoved", 70, 40, undefined],
      ["Input.dispatchMouseEvent", "mousePressed", 70, 40, "left"],
      ["Input.dispatchMouseEvent", "mouseReleased", 70, 40, "left"],
    ],
  );
});

test("CdpSession click refuses to click an element covered by another one", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: (payload) => ({
      ...pointerTarget(payload),
      receivesEvents: false,
      obscuredBy: { tagName: "DIV", id: "modal", className: null },
    }),
  });

  await assert.rejects(session.click("button.cta"), /covered by <div#modal>/);
  assert.equal(sentCommands.length, 0);
});

test("CdpSession click returns not-found results without dispatching input", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: (payload) => ({ found: false, selector: payload.selector }),
  });

  const result = await session.click("#missing");

  assert.equal(result.found, false);
  assert.equal(sentCommands.length, 0);
});

test("CdpSession type inserts text through the browser editing pipeline", async () => {
  const { session, sentCommands, runActions } = createInputSession({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    inspect: () => ({ found: true, node: { value: "hello" } }),
  });

  const result = await session.type("#field", "hello");

  assert.deepEqual(runActions, ["prepare_type", "inspect"]);
  assert.deepEqual(sentCommands, [
    { method: "Input.insertText", params: { text: "hello" } },
  ]);
  assert.equal(result.typedText, "hello");
  assert.equal(result.node.value, "hello");
});

test("CdpSession type with empty text deletes the selected value", async () => {
  const { session, sentCommands } = createInputSession({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    inspect: () => ({ found: true, node: { value: "" } }),
  });

  await session.type("#field", "");

  assert.deepEqual(
    sentCommands.map(({ method, params }) => [method, params.key]),
    [
      ["Input.dispatchKeyEvent", "Delete"],
      ["Input.dispatchKeyEvent", "Delete"],
    ],
  );
});

test("CdpSession pressKey validates the key before touching focus", async () => {
  const { session, runActions } = createInputSession({
    focus: () => ({ found: true, target: null }),
  });

  await assert.rejects(session.pressKey("Hyper"), /Unsupported key/);
  assert.deepEqual(runActions, []);
});

test("CdpSession pressKey focuses the selector and dispatches key events", async () => {
  const { session, sentCommands } = createInputSession({
    focus: () => ({
      found: true,
      target: { tagName: "INPUT", id: "q", className: null },
    }),
  });

  const result = await session.pressKey("Enter", "#q");

  assert.equal(result.dispatched, true);
  assert.equal(result.target.id, "q");
  assert.deepEqual(
    sentCommands.map(({ params }) => params.type),
    ["keyDown", "keyUp"],
  );
});

test("CdpSession type presses Enter for newlines like the Firefox path", async () => {
  const { session, sentCommands } = createInputSession({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    inspect: () => ({ found: true, node: {} }),
  });

  await session.type("#q", "shoes\r\n");

  assert.deepEqual(
    sentCommands.map(({ method, params }) => [
      method,
      params.text ?? params.key,
    ]),
    [
      ["Input.insertText", "shoes"],
      ["Input.dispatchKeyEvent", "\r"],
      ["Input.dispatchKeyEvent", "Enter"],
    ],
  );
});

test("CdpSession page action errors carry the thrown message, not Uncaught", async () => {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );
  session.send = async () => ({
    exceptionDetails: {
      text: "Uncaught",
      exception: {
        description:
          "Error: No matching <option> found\n    at runAction (<anonymous>:1:2)",
      },
    },
  });

  await assert.rejects(
    session.select("select", { label: "日本語" }),
    /^Error: No matching <option> found$/,
  );
  for (const [exception, message] of [
    [{ type: "string", value: "No matching option" }, "No matching option"],
    [{ type: "number", value: 42 }, "42"],
    [{ type: "object", subtype: "null", value: null }, "null"],
    [undefined, "Uncaught"],
  ]) {
    session.send = async () => ({
      exceptionDetails: { text: "Uncaught", exception },
    });
    await assert.rejects(session.select("select", { label: "x" }), {
      message,
    });
  }
});

function createEvaluateSession(responses) {
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );
  const sent = [];
  session.send = async (method, params) => {
    sent.push({ method, params });
    return responses[method] ?? {};
  };
  return { session, sent };
}

test("CdpSession evaluate awaits a promise the expression returns", async () => {
  const { session, sent } = createEvaluateSession({
    "Runtime.evaluate": {
      result: { type: "object", subtype: "promise", objectId: "promise-1" },
    },
    "Runtime.awaitPromise": { result: { type: "number", value: 5 } },
  });

  assert.deepEqual(await session.evaluate("Promise.resolve(5)"), {
    result: 5,
    exceptionDetails: null,
  });
  assert.equal(sent[0].params.replMode, true);
  assert.equal(sent[0].params.returnByValue, false);
  assert.deepEqual(sent[1], {
    method: "Runtime.awaitPromise",
    params: { promiseObjectId: "promise-1", returnByValue: true },
  });
  assert.deepEqual(sent[2], {
    method: "Runtime.releaseObject",
    params: { objectId: "promise-1" },
  });
});

test("CdpSession evaluate reads objects by value and reports rejections", async () => {
  const objects = createEvaluateSession({
    "Runtime.evaluate": { result: { type: "object", objectId: "object-1" } },
    "Runtime.callFunctionOn": {
      result: { type: "object", value: { a: 1 } },
    },
  });
  assert.deepEqual((await objects.session.evaluate("({ a: 1 })")).result, {
    a: 1,
  });
  assert.equal(objects.sent[1].params.objectId, "object-1");
  assert.equal(objects.sent[1].params.returnByValue, true);

  const rejected = createEvaluateSession({
    "Runtime.evaluate": {
      result: { type: "object", subtype: "promise", objectId: "promise-1" },
    },
    "Runtime.awaitPromise": {
      result: { type: "object", subtype: "error", objectId: "error-1" },
      exceptionDetails: { text: "Uncaught (in promise) Error: nope" },
    },
  });
  assert.deepEqual(await rejected.session.evaluate("Promise.reject()"), {
    result: null,
    exceptionDetails: { text: "Uncaught (in promise) Error: nope" },
  });

  const unawaited = createEvaluateSession({
    "Runtime.evaluate": {
      result: {
        type: "object",
        subtype: "promise",
        objectId: "promise-1",
        description: "Promise",
      },
    },
  });
  assert.equal(
    (
      await unawaited.session.evaluate("Promise.resolve(1)", {
        awaitPromise: false,
        returnByValue: false,
      })
    ).result,
    "Promise",
  );
  assert.deepEqual(
    unawaited.sent.map(({ method }) => method),
    ["Runtime.evaluate", "Runtime.releaseObject"],
  );
});

test("CdpSession evaluate releases exception objects too", async () => {
  const { session, sent } = createEvaluateSession({
    "Runtime.evaluate": {
      result: { type: "object", subtype: "promise", objectId: "promise-1" },
    },
    "Runtime.awaitPromise": {
      result: { type: "object", subtype: "error", objectId: "error-1" },
      exceptionDetails: {
        text: "Uncaught (in promise)",
        exception: { type: "object", subtype: "error", objectId: "error-1" },
      },
    },
  });

  await session.evaluate("Promise.reject(new Error('nope'))");

  assert.deepEqual(
    sent
      .filter(({ method }) => method === "Runtime.releaseObject")
      .map(({ params }) => params.objectId),
    ["promise-1", "error-1"],
  );
});
