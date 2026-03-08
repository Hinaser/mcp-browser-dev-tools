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
  let capturedFetchUrl = null;
  let capturedFetchBody = null;

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
      fetchImpl: async (url, options = {}) => {
        capturedFetchUrl = String(url);
        capturedFetchBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return {
              value: {
                sessionId: "webdriver-session-1",
                capabilities: {
                  browserName: "firefox",
                  webSocketUrl:
                    "ws://127.0.0.1:9222/session/webdriver-session-1",
                },
              },
            };
          },
        };
      },
    },
  );

  await manager.ensureConnected();

  assert.equal(capturedFetchUrl, "http://127.0.0.1:9222/session");
  assert.deepEqual(capturedFetchBody, {
    capabilities: {
      alwaysMatch: {
        webSocketUrl: true,
      },
    },
  });
  assert.equal(
    capturedWebSocketUrl,
    "ws://127.0.0.1:9222/session/webdriver-session-1",
  );
  assert.equal(manager.browserSessionId, "webdriver-session-1");
  assert.equal(manager.capabilities.browserName, "firefox");
});

test("closeAll deletes WebDriver-backed Firefox sessions and closes the websocket", async () => {
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
  const requests = [];
  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222",
      eventBufferSize: 10,
    },
    {
      fetchImpl: async (url, options = {}) => {
        requests.push({
          url: String(url),
          method: options.method ?? "GET",
        });
        return { ok: true };
      },
    },
  );

  manager.websocket = websocket;
  manager.browserSessionId = "webdriver-session-1";
  manager.deleteSessionUrl =
    "http://127.0.0.1:9222/session/webdriver-session-1";

  await manager.closeAll();

  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:9222/session/webdriver-session-1",
      method: "DELETE",
    },
  ]);
  assert.equal(websocket.closeCount, 1);
  assert.equal(manager.websocket, null);
  assert.equal(manager.browserSessionId, null);
});

test("getBrowserStatus times out if Firefox WebDriver session creation stalls", async () => {
  const manager = new FirefoxBidiSessionManager(
    {
      firefoxBidiWsUrl: "ws://127.0.0.1:9222",
      eventBufferSize: 10,
    },
    {
      connectionTimeoutMs: 20,
      fetchImpl: (_url, options = {}) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    },
  );

  const status = await manager.getBrowserStatus();

  assert.equal(status.available, false);
  assert.match(status.error, /Timed out creating Firefox WebDriver session/);
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
});
