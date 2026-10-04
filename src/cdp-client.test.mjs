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

// A page probe that sees no input for the first `dropped` readings, as when
// Chrome acknowledges input it never delivers.
function inputProbe({ dropped = 0, conclusive = true, node = null } = {}) {
  const readings = [];
  return {
    readings,
    input_probe(payload) {
      readings.push({ token: payload.token, disarm: payload.disarm });
      const delivered = readings.length > dropped;
      return { armed: true, delivered, conclusive, node };
    },
  };
}

test("CdpSession installs the input recorder for new documents and the current one", async () => {
  const { session, sentCommands } = createInputSession({});

  await session.installInputRecorder();

  assert.deepEqual(
    sentCommands.map(({ method }) => method),
    ["Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"],
  );
  assert.match(sentCommands[0].params.source, /\(true\)$/);
  assert.match(sentCommands[1].params.expression, /\(false\)$/);

  session.send = async () => {
    throw new Error("Page domain unavailable");
  };
  await session.installInputRecorder();
});

test("CdpSession click arms an input probe and reports the element after the click", async () => {
  const probe = inputProbe({ node: { tagName: "INPUT", checked: false } });
  let armed = null;
  const { session, sentCommands, runActions } = createInputSession({
    pointer_target: (payload) => {
      armed = payload.inputProbe;
      return { ...pointerTarget(payload), node: { checked: true } };
    },
    input_probe: probe.input_probe,
  });

  const result = await session.click("input[name=email]");

  assert.equal(typeof armed, "string");
  assert.deepEqual(runActions, ["pointer_target", "input_probe"]);
  assert.deepEqual(probe.readings, [{ token: armed, disarm: false }]);
  assert.equal(sentCommands.length, 3);
  assert.equal(result.clicked, true);
  assert.equal(result.resent, undefined);
  assert.equal(result.node.checked, false);
});

test("CdpSession click brings the tab to the front and resends a click the page never received", async () => {
  const probe = inputProbe({ dropped: 4 });
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: probe.input_probe,
  });

  const result = await session.click("button.cta");

  assert.equal(result.clicked, true);
  assert.equal(result.resent, true);
  assert.deepEqual(
    sentCommands.map(({ method, params }) => params?.type ?? method),
    [
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "Page.bringToFront",
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ],
  );
});

test("CdpSession click reports an error when the browser never delivers the click", async () => {
  const probe = inputProbe({ dropped: Infinity });
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: probe.input_probe,
  });

  await assert.rejects(session.click("button.cta"), (error) => {
    assert.equal(error.code, "INPUT_NOT_DELIVERED");
    assert.match(
      error.message,
      /^The click on "button\.cta" was sent twice, but the browser delivered no input events to the page/,
    );
    return true;
  });
  assert.equal(
    sentCommands.filter(({ method }) => method === "Input.dispatchMouseEvent")
      .length,
    6,
  );
  assert.equal(probe.readings.at(-1).disarm, true);
});

test("CdpSession click never resends when page listeners could have hidden the click", async () => {
  const probe = inputProbe({ dropped: Infinity, conclusive: false });
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: probe.input_probe,
  });

  await assert.rejects(session.click("button.cta"), {
    code: "INPUT_NOT_DELIVERED",
    message:
      /^The click on "button\.cta" was sent, but no input events reached the page, so it most likely had no effect\. It was not sent again/,
  });
  assert.equal(sentCommands.length, 3);
  assert.equal(probe.readings.at(-1).disarm, true);
});

test("CdpSession click does not resend a click that arrived while bringing the tab to the front", async () => {
  const probe = inputProbe({ dropped: 3 });
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: probe.input_probe,
  });

  const result = await session.click("button.cta");

  assert.equal(result.resent, undefined);
  assert.deepEqual(
    sentCommands.map(({ method, params }) => params?.type ?? method),
    ["mouseMoved", "mousePressed", "mouseReleased", "Page.bringToFront"],
  );
});

test("CdpSession click removes the probe when sending the click fails", async () => {
  const probe = inputProbe();
  const { session } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: probe.input_probe,
  });
  session.send = async () => {
    throw new Error("CDP session target-1 is not connected");
  };

  await assert.rejects(session.click("button.cta"), /not connected/);
  assert.deepEqual(
    probe.readings.map(({ disarm }) => disarm),
    [true],
  );
});

test("CdpSession click succeeds when the page navigated before the probe was read", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: () => ({ armed: false, delivered: false, conclusive: false }),
  });

  const result = await session.click("a.next");

  assert.equal(result.clicked, true);
  assert.equal(result.node.tagName, "BUTTON");
  assert.equal(sentCommands.length, 3);
});

test("CdpSession pressKey reports an error when the key never reaches the page", async () => {
  const probe = inputProbe({ dropped: Infinity });
  let armed = null;
  const { session } = createInputSession({
    focus: (payload) => {
      armed = payload.inputProbe;
      return { found: true, target: null };
    },
    input_probe: probe.input_probe,
  });

  await assert.rejects(session.pressKey("Space", "#email"), {
    code: "INPUT_NOT_DELIVERED",
    message: /^The key press "Space" was sent twice/,
  });
  assert.equal(probe.readings[0].token, armed);
});

test("CdpSession type resends text the page never received", async () => {
  const probe = inputProbe({ dropped: 4, node: { value: "demo" } });
  const { session, sentCommands, runActions } = createInputSession({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    input_probe: probe.input_probe,
  });

  const result = await session.type("#user", "demo");

  assert.equal(result.resent, true);
  assert.equal(result.node.value, "demo");
  assert.ok(!runActions.includes("inspect"));
  assert.deepEqual(
    sentCommands.map(({ method }) => method),
    ["Input.insertText", "Page.bringToFront", "Input.insertText"],
  );
});

test("CdpSession type skips the delivery check when it sends nothing", async () => {
  const probe = inputProbe({ dropped: Infinity });
  const { session, sentCommands } = createInputSession({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    input_probe: probe.input_probe,
    inspect: () => ({ found: true, node: { value: "kept" } }),
  });

  const result = await session.type("#user", "", { clear: false });

  assert.equal(result.node.value, "kept");
  assert.equal(sentCommands.length, 0);
  assert.deepEqual(
    probe.readings.map(({ disarm }) => disarm),
    [true],
  );
});

test("CdpSession type inserts text through the browser editing pipeline", async () => {
  const { session, sentCommands, runActions } = createInputSession({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    inspect: () => ({ found: true, node: { value: "hello" } }),
  });

  const result = await session.type("#field", "hello");

  assert.deepEqual(runActions, ["prepare_type", "input_probe", "inspect"]);
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

test("closing a tab while navigate waits does not leave an unhandled rejection", async () => {
  const { session } = createEvaluateSession({});
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let rejectNavigate;
  session.send = (method) =>
    method === "Page.navigate"
      ? new Promise((_, reject) => {
          rejectNavigate = reject;
        })
      : Promise.resolve({});

  const navigation = session.navigate("https://example.com/", {
    waitUntil: "complete",
  });
  // The tab closes: pending commands and event waiters are rejected.
  session.markClosed();
  rejectNavigate(new Error("CDP session closed"));

  await assert.rejects(navigation, /CDP session closed/);
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});

const pointTarget = (payload) => ({
  found: true,
  point: { x: payload.x, y: payload.y },
  target: { ref: "e4", tagName: "CANVAS" },
});

const delivered = () => ({ armed: true, delivered: true, conclusive: true });

function mouseEvents(sentCommands) {
  return sentCommands
    .filter(({ method }) => method === "Input.dispatchMouseEvent")
    .map(({ params }) =>
      [
        params.type,
        params.button,
        params.clickCount,
        params.buttons,
        params.x,
        params.y,
      ].filter((value) => value !== undefined),
    );
}

test("CdpSession clicks a point with any button and click count", async () => {
  const { session, sentCommands } = createInputSession({
    point_target: pointTarget,
    input_probe: delivered,
  });

  const result = await session.click(
    { x: 12, y: 34 },
    { button: "right", clickCount: 2 },
  );

  assert.deepEqual(result.point, { x: 12, y: 34 });
  assert.deepEqual(result.target, { ref: "e4", tagName: "CANVAS" });
  assert.equal(result.selector, undefined);
  assert.deepEqual(mouseEvents(sentCommands), [
    ["mouseMoved", 12, 34],
    ["mousePressed", "right", 1, 2, 12, 34],
    ["mouseReleased", "right", 1, 0, 12, 34],
    ["mousePressed", "right", 2, 2, 12, 34],
    ["mouseReleased", "right", 2, 0, 12, 34],
  ]);
});

test("CdpSession scrolls with a real mouse wheel at a point", async () => {
  const { session, sentCommands } = createInputSession({
    point_target: pointTarget,
  });

  const result = await session.scroll({ x: 50, y: 60, deltaY: 120 });

  assert.equal(result.scrolled, true);
  assert.deepEqual(sentCommands, [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 50, y: 60, deltaX: 0, deltaY: 120 },
    },
  ]);
});

test("CdpSession drags with mouse moves when the page starts no HTML5 drag", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    point_target: pointTarget,
    input_probe: delivered,
  });

  const result = await session.drag("#thumb", { x: 170, y: 40 }, { steps: 2 });

  assert.equal(result.dragged, true);
  assert.equal(result.html5, false);
  assert.deepEqual(result.from, {
    selector: "#thumb",
    point: { x: 70, y: 40 },
  });
  assert.deepEqual(mouseEvents(sentCommands), [
    ["mouseMoved", 70, 40],
    ["mousePressed", "left", 1, 1, 70, 40],
    ["mouseMoved", "left", 1, 120, 40],
    ["mouseMoved", "left", 1, 170, 40],
    ["mouseReleased", "left", 1, 0, 170, 40],
  ]);
  assert.deepEqual(
    sentCommands
      .filter(({ method }) => method === "Input.setInterceptDrags")
      .map(({ params }) => params.enabled),
    [true, false],
  );
});

test("CdpSession finishes an HTML5 drag with drag events once Chrome intercepts it", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: delivered,
  });
  const data = { items: [{ mimeType: "text/plain", data: "item-1" }] };
  const send = session.send;
  session.send = async (method, params) => {
    const result = await send(method, params);
    if (params?.type === "mouseMoved" && params.buttons === 1) {
      session.bufferEvent("Input.dragIntercepted", { data });
    }
    return result;
  };

  const result = await session.drag("#item", "#zone", { steps: 3 });

  assert.equal(result.html5, true);
  const drags = sentCommands
    .filter(({ method }) => method === "Input.dispatchDragEvent")
    .map(({ params }) => [params.type, params.data]);
  assert.deepEqual(
    drags.map(([type]) => type),
    ["dragEnter", "dragOver", "dragOver", "drop"],
  );
  assert.ok(drags.every(([, sent]) => sent === data));
  assert.deepEqual(mouseEvents(sentCommands).at(-1), [
    "mouseReleased",
    "left",
    1,
    0,
    70,
    40,
  ]);
});

test("CdpSession releases the button when a drag fails after the press", async () => {
  const { session, sentCommands } = createInputSession({
    pointer_target: pointerTarget,
    input_probe: delivered,
  });
  const send = session.send;
  session.send = async (method, params) => {
    if (params?.type === "mouseMoved" && params.buttons === 1) {
      throw new Error("Target closed");
    }
    return send(method, params);
  };

  await assert.rejects(session.drag("#a", "#b"), /Target closed/);
  assert.deepEqual(mouseEvents(sentCommands).at(-1), [
    "mouseReleased",
    "left",
    1,
    0,
    70,
    40,
  ]);
  assert.deepEqual(sentCommands.at(-1), {
    method: "Input.setInterceptDrags",
    params: { enabled: false },
  });
});

test("CdpSession sets files on a file input through its object handle", async () => {
  const { session, sentCommands } = createInputSession({
    file_input: (payload) => ({
      found: true,
      selector: payload.selector,
      fileInput: true,
      multiple: true,
      accept: ".csv",
      disabled: false,
    }),
  });
  const send = session.send;
  session.send = async (method, params) => {
    await send(method, params);
    return method === "Runtime.evaluate"
      ? { result: { objectId: "obj-1" } }
      : {};
  };

  const result = await session.uploadFiles("#files", [
    "/tmp/a.csv",
    "/tmp/b.csv",
  ]);

  assert.deepEqual(result.uploaded, ["a.csv", "b.csv"]);
  assert.deepEqual(
    sentCommands.find(({ method }) => method === "DOM.setFileInputFiles")
      .params,
    { files: ["/tmp/a.csv", "/tmp/b.csv"], objectId: "obj-1" },
  );
});

test("CdpSession takes the file chooser a button opens", async () => {
  const { session, sentCommands } = createInputSession({
    file_input: (payload) => ({
      found: true,
      selector: payload.selector,
      fileInput: false,
    }),
    pointer_target: pointerTarget,
    input_probe: delivered,
  });
  const send = session.send;
  session.send = async (method, params) => {
    const result = await send(method, params);
    if (params?.type === "mouseReleased") {
      session.bufferEvent("Page.fileChooserOpened", {
        mode: "selectSingle",
        backendNodeId: 42,
      });
    }
    return result;
  };

  const result = await session.uploadFiles("#pick", ["/tmp/a.csv"]);

  assert.equal(result.chooser, true);
  assert.deepEqual(
    sentCommands.find(({ method }) => method === "DOM.setFileInputFiles")
      .params,
    { files: ["/tmp/a.csv"], backendNodeId: 42 },
  );
  assert.deepEqual(
    sentCommands
      .filter(({ method }) => method === "Page.setInterceptFileChooserDialog")
      .map(({ params }) => params.enabled),
    [true, false],
  );
});

test("CdpSession pauses only matching requests and blocks or mocks them", async () => {
  const { session, sentCommands } = createInputSession({});

  await session.setNetwork({
    rules: [
      { url: "*/ads/*", action: "block" },
      { url: "*/api/*", action: "mock", status: 201, body: "ok" },
    ],
    headers: { "X-Test": "1" },
    latencyMs: 200,
    downloadKbps: 800,
  });
  assert.deepEqual(
    sentCommands.map(({ method }) => method),
    [
      "Fetch.enable",
      "Network.setExtraHTTPHeaders",
      "Network.emulateNetworkConditions",
    ],
  );
  assert.deepEqual(sentCommands[0].params.patterns, [
    { urlPattern: "*/ads/*", requestStage: "Request" },
    { urlPattern: "*/api/*", requestStage: "Request" },
  ]);
  assert.deepEqual(sentCommands[2].params, {
    offline: false,
    latency: 200,
    downloadThroughput: 102_400,
    uploadThroughput: -1,
  });

  sentCommands.length = 0;
  await session.handleRequestPaused({
    requestId: "r1",
    request: { url: "https://a/ads/x.js" },
  });
  await session.handleRequestPaused({
    requestId: "r2",
    request: { url: "https://a/api/data" },
  });
  assert.deepEqual(sentCommands[0], {
    method: "Fetch.failRequest",
    params: { requestId: "r1", errorReason: "BlockedByClient" },
  });
  assert.equal(sentCommands[1].method, "Fetch.fulfillRequest");
  assert.equal(sentCommands[1].params.responseCode, 201);
  assert.equal(
    Buffer.from(sentCommands[1].params.body, "base64").toString(),
    "ok",
  );

  sentCommands.length = 0;
  const cleared = await session.setNetwork({ rules: [] });
  assert.deepEqual(cleared.rules, []);
  assert.deepEqual(
    sentCommands.map(({ method }) => method),
    ["Fetch.disable"],
  );
});

test("CdpSession releases a paused request it could not answer", async () => {
  const { session, sentCommands } = createInputSession({});
  await session.setNetwork({ rules: [{ url: "*", action: "mock" }] });
  const send = session.send;
  session.send = async (method, params) => {
    if (method === "Fetch.fulfillRequest") {
      throw new Error("Invalid header");
    }
    return send(method, params);
  };
  sentCommands.length = 0;

  await session.handleRequestPaused({
    requestId: "r1",
    request: { url: "https://a" },
  });
  assert.deepEqual(sentCommands, [
    { method: "Fetch.continueRequest", params: { requestId: "r1" } },
  ]);
});

test("CdpSession applies overlapping set_network calls in order", async () => {
  const { session, sentCommands } = createInputSession({});
  let release;
  const send = session.send;
  session.send = async (method, params) => {
    if (method === "Fetch.enable") {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return send(method, params);
  };

  const first = session.setNetwork({
    rules: [{ url: "*", action: "block" }],
    offline: true,
  });
  const reset = session.setNetwork({ reset: true });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  const state = await reset;

  assert.equal(state.offline, false);
  assert.deepEqual(state.rules, []);
  const conditions = sentCommands.filter(
    ({ method }) => method === "Network.emulateNetworkConditions",
  );
  assert.equal(conditions.at(-1).params.offline, false);
});

test("CdpSession runs a frame ref's action in that frame and moves its point", async () => {
  const { session, sentCommands } = createInputSession({});
  session.frameKeys.keyFor("frame-x", {
    id: "frame-x",
    url: "https://x",
    sessionId: "child-1",
    root: true,
  });
  session.frameSessions.set("child-1", {
    sessionId: "child-1",
    frameId: "frame-x",
    parentSessionId: null,
  });
  session.send = async (method, params, sessionId) => {
    sentCommands.push({ method, params, sessionId });
    if (method === "DOM.getFrameOwner") {
      return { backendNodeId: 7 };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { content: [200, 100, 0, 0, 0, 0, 0, 0] } };
    }
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: JSON.stringify({
            found: true,
            selector: "ref=e2",
            point: { x: 10, y: 20 },
            receivesEvents: true,
          }),
        },
      };
    }
    return {};
  };
  delete session.runPageAction;

  const result = await session.runPageAction({
    action: "pointer_target",
    selector: "ref=f1e2",
  });

  assert.deepEqual(result.point, { x: 210, y: 120 });
  assert.equal(result.selector, "ref=f1e2");
  const evaluate = sentCommands.find(
    ({ method }) => method === "Runtime.evaluate",
  );
  assert.equal(evaluate.sessionId, "child-1");
  assert.match(evaluate.params.expression, /"selector":"ref=e2"/);
});
