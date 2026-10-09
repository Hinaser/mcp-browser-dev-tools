import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeFirefoxContext,
  resolveBidiEventContext,
  summarizeBidiRemoteValue,
  FirefoxBidiSessionManager,
} from "./firefox-bidi-client.mjs";

test("normalizeFirefoxContext maps browsing contexts to broker tabs", () => {
  assert.deepEqual(
    normalizeFirefoxContext({
      context: "ctx-1",
      url: "https://example.com/docs",
      userContext: "default",
      clientWindow: "window-1",
    }),
    {
      targetId: "ctx-1",
      type: "page",
      title: "example.com",
      url: "https://example.com/docs",
      attached: false,
      userContext: "default",
      clientWindow: "window-1",
    },
  );
});

test("resolveBidiEventContext extracts the context from event payloads", () => {
  assert.equal(
    resolveBidiEventContext("log.entryAdded", {
      source: { context: "ctx-1" },
    }),
    "ctx-1",
  );
  assert.equal(
    resolveBidiEventContext("network.beforeRequestSent", {
      context: "ctx-2",
    }),
    "ctx-2",
  );
  assert.equal(resolveBidiEventContext("custom", {}), null);
});

test("summarizeBidiRemoteValue converts common remote values", () => {
  assert.equal(summarizeBidiRemoteValue({ type: "string", value: "ok" }), "ok");
  assert.deepEqual(
    summarizeBidiRemoteValue({
      type: "object",
      value: [
        [
          { type: "string", value: "title" },
          { type: "string", value: "Example" },
        ],
      ],
    }),
    { title: "Example" },
  );
  assert.deepEqual(
    summarizeBidiRemoteValue({
      type: "array",
      value: [
        { type: "number", value: 1 },
        { type: "number", value: 2 },
      ],
    }),
    [1, 2],
  );
});

test("getDocument normalizes depth before embedding it in the Firefox expression", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });

  manager.sessions.set("session-1", {
    target: { targetId: "ctx-1" },
  });

  let capturedExpression = null;
  manager.send = async (_method, params) => {
    capturedExpression = params.expression;
    return {
      type: "success",
      result: {
        type: "string",
        value: JSON.stringify({
          title: "Example",
          url: "https://example.com",
          readyState: "complete",
          requestedDepth: 2,
          outerHTML: "<html></html>",
        }),
      },
    };
  };

  const document = await manager.getDocument(
    "session-1",
    '0, injected: (() => "boom")()',
  );

  assert.equal(capturedExpression.includes("injected"), false);
  assert.equal(document.requestedDepth, 2);
});

test("createTab returns the created Firefox browsing context", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });

  manager.ensureConnected = async () => {};
  manager.send = async (method, params) => {
    if (method === "browsingContext.create") {
      assert.deepEqual(params, { type: "tab" });
      return { context: "ctx-2" };
    }

    if (method === "browsingContext.navigate") {
      assert.equal(params.context, "ctx-2");
      assert.equal(params.url, "https://example.com/docs");
      assert.equal(params.wait, "complete");
      return { navigation: "nav-1" };
    }

    throw new Error(`Unexpected method: ${method}`);
  };
  manager.listTargets = async () => [
    {
      targetId: "ctx-2",
      type: "page",
      title: "example.com",
      url: "https://example.com/docs",
      attached: false,
      userContext: null,
      clientWindow: null,
    },
  ];

  const target = await manager.createTab("https://example.com/docs");

  assert.equal(target.browserFamily, "firefox");
  assert.equal(target.targetId, "ctx-2");
  assert.equal(target.url, "https://example.com/docs");
});

test("closeTarget removes attached Firefox sessions for the closed context", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });

  manager.ensureConnected = async () => {};
  manager.send = async (method, params) => {
    assert.equal(method, "browsingContext.close");
    assert.deepEqual(params, { context: "ctx-1" });
    return {};
  };

  manager.sessions.set("session-1", {
    id: "session-1",
    target: { targetId: "ctx-1" },
    closed: false,
  });
  manager.sessions.set("session-2", {
    id: "session-2",
    target: { targetId: "ctx-2" },
    closed: false,
  });

  const result = await manager.closeTarget("ctx-1");

  assert.equal(result.closed, true);
  assert.deepEqual(result.detachedSessions, [{ sessionId: "session-1" }]);
  assert.equal(manager.sessions.get("session-2").closed, false);
  assert.equal(manager.sessions.has("session-1"), false);
});

test("FirefoxBidiSessionManager waitFor resolves when readyState reaches complete", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });

  let attempt = 0;
  manager.getPageState = async () => {
    attempt += 1;
    return {
      browserFamily: "firefox",
      url: "https://example.com/app",
      readyState: attempt >= 2 ? "complete" : "interactive",
    };
  };

  const result = await manager.waitFor("session-1", {
    readyState: "complete",
    timeoutMs: 50,
    pollIntervalMs: 1,
  });

  assert.equal(result.matched, true);
  assert.equal(result.page.readyState, "complete");
  assert.equal(result.attempts, 2);
});

test("ensureConnected rejects if the websocket closes before opening", async () => {
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
      eventBufferSize: 10,
    },
    {
      websocketFactory: () => new FakeSocket(),
    },
  );

  await assert.rejects(manager.ensureConnected(), /closed before it connected/);
});

test("ensureConnected bootstraps a Firefox WebDriver session from the root endpoint", async () => {
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  let capturedWebSocketUrl = null;

  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222",
      eventBufferSize: 10,
    },
    {
      websocketFactory: (url) => {
        capturedWebSocketUrl = url;
        return new FakeSocket();
      },
    },
  );
  manager.send = async (method) => {
    assert.equal(method, "session.new");
    return {
      sessionId: "webdriver-session-1",
      capabilities: {
        browserName: "firefox",
        webSocketUrl: "ws://127.0.0.1:9222/session/webdriver-session-1",
      },
    };
  };

  await manager.ensureConnected();

  assert.equal(capturedWebSocketUrl, "ws://127.0.0.1:9222/session");
  assert.equal(manager.browserSessionId, "webdriver-session-1");
  assert.equal(manager.capabilities.browserName, "firefox");
});

test("ensureConnected auto-discovers a loopback Firefox BiDi endpoint when using the default port", async () => {
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      queueMicrotask(() => {
        if (url.includes(":9223/")) {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          return;
        }

        this.readyState = 3;
        this.dispatchEvent(new Event("error"));
        this.dispatchEvent(new Event("close"));
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const capturedUrls = [];
  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222",
      eventBufferSize: 10,
    },
    {
      websocketFactory: (url) => {
        capturedUrls.push(url);
        return new FakeSocket(url);
      },
    },
  );
  manager.send = async (method) => {
    assert.equal(method, "session.new");
    return {
      sessionId: "webdriver-session-1",
      capabilities: {
        browserName: "firefox",
      },
    };
  };

  await manager.ensureConnected();

  assert.deepEqual(capturedUrls.slice(0, 2), [
    "ws://127.0.0.1:9222/session",
    "ws://127.0.0.1:9223/session",
  ]);
  assert.equal(manager.browserSessionId, "webdriver-session-1");
  assert.equal(manager.resolvedWebSocketUrl, "ws://127.0.0.1:9223/session");
});

test("stale Firefox socket close events do not clear a newer connection", async () => {
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.closeCount = 0;

      queueMicrotask(() => {
        if (url.includes(":9222/")) {
          this.dispatchEvent(new Event("error"));
          return;
        }

        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send() {}

    close() {
      this.closeCount += 1;
      this.readyState = 2;
      setTimeout(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }, 80);
    }
  }

  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222",
      eventBufferSize: 10,
    },
    {
      websocketFactory: (url) => new FakeSocket(url),
    },
  );
  manager.send = async (method) => {
    assert.equal(method, "session.new");
    return {
      sessionId: "webdriver-session-1",
      capabilities: {
        browserName: "firefox",
      },
    };
  };

  await manager.ensureConnected();
  manager.sessions.set("session-1", {
    id: "session-1",
    target: { targetId: "ctx-1" },
    closed: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(manager.browserSessionId, "webdriver-session-1");
  assert.equal(manager.sessions.has("session-1"), true);
  assert.equal(manager.resolvedWebSocketUrl, "ws://127.0.0.1:9223/session");
});

test("FirefoxBidiSessionManager auto-dismisses alert dialogs via browsingContext.handleUserPrompt", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });

  const session = {
    id: "session-1",
    target: { targetId: "ctx-1" },
    closed: false,
    bufferedEvents: [],
    bufferEvent(method, params) {
      this.bufferedEvents.push({ method, params });
    },
  };
  manager.sessions.set("session-1", session);

  const sentCommands = [];
  manager.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };
  manager.websocket = { readyState: 1 };

  await manager.handleMessage(
    JSON.stringify({
      type: "event",
      method: "browsingContext.userPromptOpened",
      params: {
        context: "ctx-1",
        type: "alert",
        message: "Hello!",
      },
    }),
  );

  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, "browsingContext.handleUserPrompt");
  assert.equal(sentCommands[0].params.context, "ctx-1");
  assert.equal(sentCommands[0].params.accept, true);
  assert.equal(session.bufferedEvents.length, 1);
});

test("FirefoxBidiSessionManager auto-dismisses prompt dialogs with accept=false", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });

  const session = {
    id: "session-1",
    target: { targetId: "ctx-1" },
    closed: false,
    bufferedEvents: [],
    bufferEvent(method, params) {
      this.bufferedEvents.push({ method, params });
    },
  };
  manager.sessions.set("session-1", session);

  const sentCommands = [];
  manager.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };
  manager.websocket = { readyState: 1 };

  await manager.handleMessage(
    JSON.stringify({
      type: "event",
      method: "browsingContext.userPromptOpened",
      params: {
        context: "ctx-1",
        type: "prompt",
        message: "Enter value:",
      },
    }),
  );

  assert.equal(sentCommands[0].params.accept, false);
});

test("closeAll ends the Firefox session and closes the websocket", async () => {
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 1;
      this.closeCount = 0;
    }

    addEventListener(...args) {
      return super.addEventListener(...args);
    }

    close() {
      this.closeCount += 1;
      this.readyState = 2;
      queueMicrotask(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      });
    }
  }

  const websocket = new FakeSocket();
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222",
    eventBufferSize: 10,
  });

  manager.websocket = websocket;
  manager.browserSessionId = "webdriver-session-1";
  const sentMethods = [];
  manager.send = async (method) => {
    sentMethods.push(method);
    return {};
  };

  await manager.closeAll();

  assert.deepEqual(sentMethods, ["session.end"]);
  assert.equal(websocket.closeCount, 1);
  assert.equal(manager.websocket, null);
  assert.equal(manager.browserSessionId, null);
});

test("getBrowserStatus times out if the Firefox /session websocket never opens", async () => {
  class HangingSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.closeCount = 0;
    }

    send() {}

    close() {
      this.closeCount += 1;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const websocket = new HangingSocket();
  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9333",
      eventBufferSize: 10,
    },
    {
      connectionTimeoutMs: 20,
      websocketFactory: () => websocket,
    },
  );

  const status = await manager.getBrowserStatus();

  assert.equal(status.available, false);
  assert.match(status.error, /Timed out connecting to Firefox BiDi/);
  assert.equal(websocket.closeCount, 1);
  assert.equal(manager.resolvedWebSocketUrl, null);
});

test("getBrowserStatus times out if the Firefox websocket never opens", async () => {
  class HangingSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.closeCount = 0;
    }

    send() {}

    close() {
      this.closeCount += 1;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const websocket = new HangingSocket();
  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
      eventBufferSize: 10,
    },
    {
      connectionTimeoutMs: 20,
      websocketFactory: () => websocket,
    },
  );

  const status = await manager.getBrowserStatus();

  assert.equal(status.available, false);
  assert.match(status.error, /Timed out connecting to Firefox BiDi/);
  assert.equal(websocket.closeCount, 1);
  assert.equal(manager.resolvedWebSocketUrl, null);
});

function createBidiInputManager(pageActions) {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });
  manager.sessions.set("session-1", {
    id: "session-1",
    target: { targetId: "ctx-1" },
    closed: false,
    bufferedEvents: [],
  });

  const sentCommands = [];
  manager.send = async (method, params) => {
    sentCommands.push({ method, params });
    return {};
  };
  manager.runPageAction = async (_session, payload) =>
    pageActions[payload.action](payload);

  return { manager, sentCommands };
}

test("FirefoxBidiSessionManager click performs pointer actions at the element center", async () => {
  const { manager, sentCommands } = createBidiInputManager({
    pointer_target: () => ({
      found: true,
      selector: "button",
      point: { x: 70.4, y: 39.6 },
      receivesEvents: true,
      node: {},
    }),
  });

  await manager.click("session-1", "button");

  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, "input.performActions");
  assert.equal(sentCommands[0].params.context, "ctx-1");
  assert.deepEqual(sentCommands[0].params.actions[0].actions, [
    { type: "pointerMove", x: 70, y: 40, origin: "viewport" },
    { type: "pointerDown", button: 0 },
    { type: "pointerUp", button: 0 },
  ]);
});

test("FirefoxBidiSessionManager installs the input recorder and removes it on detach", async () => {
  const { manager, sentCommands } = createBidiInputManager({});
  manager.send = async (method, params) => {
    sentCommands.push({ method, params });
    return method === "script.addPreloadScript" ? { script: "preload-1" } : {};
  };
  const session = manager.getSession("session-1");

  await manager.installInputRecorder(session);
  await manager.detachSession("session-1");

  assert.deepEqual(
    sentCommands.map(({ method }) => method),
    [
      "script.addPreloadScript",
      "script.evaluate",
      "script.removePreloadScript",
    ],
  );
  assert.deepEqual(sentCommands[0].params.contexts, ["ctx-1"]);
  assert.match(sentCommands[0].params.functionDeclaration, /\(true\)$/);
  assert.match(sentCommands[1].params.expression, /\(false\)$/);
  assert.deepEqual(sentCommands[2].params, { script: "preload-1" });
});

test("FirefoxBidiSessionManager click reports an error when the page never receives it", async () => {
  const readings = [];
  const { manager, sentCommands } = createBidiInputManager({
    pointer_target: (payload) => ({
      found: true,
      selector: "button",
      point: { x: 70, y: 40 },
      receivesEvents: true,
      node: {},
      armed: payload.inputProbe,
    }),
    input_probe: (payload) => {
      readings.push(payload.disarm);
      return { armed: true, delivered: false, conclusive: true };
    },
  });

  await assert.rejects(manager.click("session-1", "button"), {
    code: "INPUT_NOT_DELIVERED",
  });
  assert.equal(sentCommands.length, 2);
  assert.equal(readings.at(-1), true);
});

test("FirefoxBidiSessionManager type sends key actions for each character", async () => {
  const { manager, sentCommands } = createBidiInputManager({
    prepare_type: () => ({ found: true, method: "native", node: {} }),
    inspect: () => ({ found: true, node: { value: "hi" } }),
  });

  const result = await manager.type("session-1", "#field", "hi");

  assert.equal(result.node.value, "hi");
  assert.deepEqual(sentCommands[0].params.actions, [
    {
      type: "key",
      id: "mcp-keyboard",
      actions: [
        { type: "keyDown", value: "h" },
        { type: "keyUp", value: "h" },
        { type: "keyDown", value: "i" },
        { type: "keyUp", value: "i" },
      ],
    },
  ]);
});

test("FirefoxBidiSessionManager evaluate runs top-level await in an async function", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });
  manager.sessions.set("session-1", { target: { targetId: "ctx-1" } });
  const sent = [];
  manager.send = async (method, params) => {
    sent.push(params.expression);
    return { type: "success", result: { type: "number", value: 6 } };
  };

  assert.equal(
    (await manager.evaluate("session-1", "await Promise.resolve(6)")).result,
    6,
  );
  await manager.evaluate("session-1", "document.title");

  assert.equal(
    sent[0],
    "(async () => {\nreturn (\nawait Promise.resolve(6)\n);\n})()",
  );
  assert.equal(sent[1], "document.title");
});

test("FirefoxBidiSessionManager intercepts the tab's requests and answers each by its rules", async () => {
  const { manager, sentCommands } = createBidiInputManager({});
  const send = manager.send;
  manager.send = async (method, params) => {
    await send(method, params);
    return method === "network.addIntercept" ? { intercept: "i-1" } : {};
  };

  await manager.setNetwork("session-1", {
    rules: [
      { url: "*/ads/*", action: "block" },
      {
        url: "*/api/*",
        action: "mock",
        body: "{}",
        contentType: "application/json",
      },
    ],
    headers: { "X-Test": "1" },
  });
  assert.deepEqual(sentCommands[0], {
    method: "network.addIntercept",
    params: { phases: ["beforeRequestSent"], contexts: ["ctx-1"] },
  });
  await assert.rejects(
    manager.setNetwork("session-1", { latencyMs: 100 }),
    /Chromium only/,
  );

  const session = manager.sessions.get("session-1");
  const blocked = (id, url) => ({
    isBlocked: true,
    intercepts: ["i-1"],
    request: {
      request: id,
      url,
      headers: [{ name: "Accept", value: { type: "string", value: "*/*" } }],
    },
  });
  sentCommands.length = 0;
  await manager.handleBlockedRequest(session, blocked("r1", "https://a/ads/x"));
  await manager.handleBlockedRequest(session, blocked("r2", "https://a/api/d"));
  await manager.handleBlockedRequest(session, blocked("r3", "https://a/page"));
  assert.deepEqual(
    sentCommands.map(({ method }) => method),
    [
      "network.failRequest",
      "network.provideResponse",
      "network.continueRequest",
    ],
  );
  assert.equal(sentCommands[1].params.statusCode, 200);
  assert.deepEqual(sentCommands[1].params.body, {
    type: "string",
    value: "{}",
  });
  assert.deepEqual(sentCommands[2].params.headers, [
    { name: "Accept", value: { type: "string", value: "*/*" } },
    { name: "X-Test", value: { type: "string", value: "1" } },
  ]);

  sentCommands.length = 0;
  await manager.setNetwork("session-1", { reset: true });
  assert.equal(sentCommands.at(-1).method, "network.removeIntercept");
});

test("FirefoxBidiSessionManager routes paused requests by intercept, waits for one being added, and releases strays", async () => {
  const { manager, sentCommands } = createBidiInputManager({});
  manager.sessions.get("session-1").bufferEvent = () => {};
  let finishAdding;
  const send = manager.send;
  manager.send = async (method, params) => {
    await send(method, params);
    if (method === "network.addIntercept") {
      await new Promise((resolve) => {
        finishAdding = resolve;
      });
      return { intercept: "i-1" };
    }
    return {};
  };
  const paused = (id, context, intercepts = ["i-1"]) => ({
    type: "event",
    method: "network.beforeRequestSent",
    params: {
      context,
      isBlocked: true,
      intercepts,
      request: { request: id, url: "https://a/ads/x", headers: [] },
    },
  });

  const setting = manager.setNetwork("session-1", {
    rules: [{ url: "*/ads/*", action: "block" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Paused before addIntercept answered, from an iframe of the tab.
  await manager.handleMessage(JSON.stringify(paused("r1", "frame-9")));
  assert.equal(
    sentCommands.some(({ method }) => method === "network.failRequest"),
    false,
  );
  finishAdding();
  await setting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sentCommands.find(({ method }) => method === "network.failRequest").params,
    { request: "r1" },
  );

  // An intercept nobody owns any more: the request is let go.
  await manager.handleMessage(JSON.stringify(paused("r2", "ctx-1", ["gone"])));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sentCommands.at(-1), {
    method: "network.continueRequest",
    params: { request: "r2" },
  });
});

test("FirefoxBidiSessionManager adds one intercept for overlapping calls and clears offline on detach", async () => {
  const { manager, sentCommands } = createBidiInputManager({});
  let count = 0;
  const send = manager.send;
  manager.send = async (method, params) => {
    await send(method, params);
    return method === "network.addIntercept"
      ? { intercept: `i-${++count}` }
      : {};
  };
  const rules = [{ url: "*/ads/*", action: "block" }];

  await Promise.all([
    manager.setNetwork("session-1", { rules }),
    manager.setNetwork("session-1", { rules, offline: true }),
  ]);
  assert.equal(
    sentCommands.filter(({ method }) => method === "network.addIntercept")
      .length,
    1,
  );
  await assert.rejects(
    manager.setNetwork("session-1", {
      rules: [{ url: "*", action: "mock", headers: { "Bad Header": "x" } }],
    }),
    /invalid header name/,
  );

  sentCommands.length = 0;
  await manager.detachSession("session-1").catch(() => {});
  assert.deepEqual(sentCommands.map(({ method }) => method).slice(0, 2), [
    "network.removeIntercept",
    "emulation.setNetworkConditions",
  ]);
});

test("FirefoxBidiSessionManager removes an intercept that arrives after detach", async () => {
  const { manager, sentCommands } = createBidiInputManager({});
  let finishAdding;
  const send = manager.send;
  manager.send = async (method, params) => {
    await send(method, params);
    if (method === "network.addIntercept") {
      await new Promise((resolve) => {
        finishAdding = resolve;
      });
      return { intercept: "late" };
    }
    return {};
  };

  const setting = manager.setNetwork("session-1", {
    rules: [{ url: "*", action: "block" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const detaching = manager.detachSession("session-1").catch(() => {});
  finishAdding();
  await setting.catch(() => {});
  await detaching;

  assert.deepEqual(
    sentCommands.find(({ method }) => method === "network.removeIntercept")
      .params,
    { intercept: "late" },
  );
  await assert.rejects(
    manager.setNetwork("session-1", { reset: true }),
    /Unknown|detached|session/i,
  );
});

test("FirefoxBidiSessionManager sends input for a frame element to the frame's context", async () => {
  const { manager, sentCommands } = createBidiInputManager({});
  const session = manager.sessions.get("session-1");
  manager
    .frameKeys(session)
    .keyFor("ctx-frame", { url: "https://x", parent: "ctx-1" });
  manager.frameOffset = async () => ({ x: 300, y: 80 });
  manager.runPageAction = async (_session, payload, options) => {
    if (payload.selector === "ref=f1e2" && !options?.context) {
      return manager.runInFrame(session, "f1", {
        ...payload,
        selector: "ref=e2",
      });
    }
    if (payload.action === "pointer_target") {
      assert.equal(options.context, "ctx-frame");
      return {
        found: true,
        selector: payload.selector,
        point: { x: 10, y: 20 },
        receivesEvents: true,
        node: {},
      };
    }
    return { armed: false };
  };

  const result = await manager.click("session-1", "ref=f1e2");

  assert.deepEqual(result.point, { x: 310, y: 100 });
  const actions = sentCommands.find(
    ({ method }) => method === "input.performActions",
  );
  assert.equal(actions.params.context, "ctx-frame");
  assert.deepEqual(actions.params.actions[0].actions[0], {
    type: "pointerMove",
    x: 10,
    y: 20,
    origin: "viewport",
  });
});

test("record_video is Chromium only on Firefox", async () => {
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });
  await assert.rejects(
    manager.startVideo("session-1", {}),
    /record_video is Chromium only; WebDriver BiDi has no screencast/,
  );
  await assert.rejects(manager.stopVideo("session-1"), /Chromium only/);
});
