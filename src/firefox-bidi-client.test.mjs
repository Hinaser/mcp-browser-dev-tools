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
    firefoxBidiWsUrl: "ws://127.0.0.1:9222",
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
      firefoxBidiWsUrl: "ws://127.0.0.1:9222",
      eventBufferSize: 10,
    },
    {
      websocketFactory: () => new FakeSocket(),
    },
  );

  await assert.rejects(manager.ensureConnected(), /closed before it connected/);
});
