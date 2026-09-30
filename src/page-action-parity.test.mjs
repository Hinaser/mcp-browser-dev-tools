import assert from "node:assert/strict";
import test from "node:test";

import { CdpSession } from "./cdp-client.mjs";
import { FirefoxBidiSessionManager } from "./firefox-bidi-client.mjs";

// The Chromium and Firefox clients each build the payloads for the shared
// page script. These checks keep the two in step, so an option added to one
// client is not silently missing from the other.

function fakeResult(payload) {
  if (payload.action === "pointer_target") {
    return {
      found: true,
      selector: payload.selector,
      point: { x: 10, y: 10 },
      receivesEvents: true,
      node: { disabled: false },
    };
  }
  return { found: true, page: {} };
}

function createCdpClient() {
  const calls = [];
  const session = new CdpSession(
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    },
    { config: { browserFamily: "chromium" } },
  );
  session.runPageAction = async (payload, options = {}) => {
    calls.push({ payload, gesture: options.userGesture === true });
    return fakeResult(payload);
  };
  return {
    calls,
    run: (method, ...args) => session[method](...args),
  };
}

function createBidiClient() {
  const calls = [];
  const manager = new FirefoxBidiSessionManager({
    firefoxBidiWsUrl: "ws://127.0.0.1:9222/session/direct",
    eventBufferSize: 10,
  });
  manager.sessions.set("session-1", { target: { targetId: "ctx-1" } });
  manager.runPageAction = async (session, payload, options = {}) => {
    calls.push({ payload, gesture: options.userActivation === true });
    return fakeResult(payload);
  };
  return {
    calls,
    run: (method, ...args) =>
      method === "resolvePointerTarget"
        ? manager[method](manager.getSession("session-1"), ...args)
        : manager[method]("session-1", ...args),
  };
}

const CASES = [
  ["getPageState"],
  ["getCookies"],
  ["getStorage"],
  ["snapshotControls"],
  ["inspectElement", "#status"],
  [
    "inspectElement",
    "#status",
    {
      textChecks: [
        { textEquals: null, textIncludes: "Paid", textExcludes: null },
      ],
    },
  ],
  ["resolvePointerTarget", 'role=button[name="Save"]'],
  ["select", "select[name=plan]", { value: "pro" }],
  ["select", "select[name=plan]", { label: "Pro" }],
  ["scroll", { selector: "#footer", block: "end" }],
  ["scroll", { deltaX: 0, deltaY: 400 }],
  [
    "restoreSessionSnapshot",
    { cookies: { entries: [] }, storage: {} },
    { clearStorage: true },
  ],
];

for (const [method, ...args] of CASES) {
  test(`${method}(${JSON.stringify(args)}) sends the same page script payload on Chromium and Firefox`, async () => {
    const cdp = createCdpClient();
    const bidi = createBidiClient();

    await cdp.run(method, ...args);
    await bidi.run(method, ...args);

    assert.ok(cdp.calls.length > 0);
    assert.deepEqual(bidi.calls, cdp.calls);
  });
}
