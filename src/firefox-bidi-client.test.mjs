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
