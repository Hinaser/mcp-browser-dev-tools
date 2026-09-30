import assert from "node:assert/strict";
import test from "node:test";

import { inputRecorder, pageScript } from "./page-script.mjs";

// Runs the page script's input probe against a bare window: an EventTarget
// that receives "trusted" keyboard events, standing in for the browser.
class TrustedEvent extends Event {
  get isTrusted() {
    return true;
  }
}

function withWindow(run) {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget();
  globalThis.document = { activeElement: null, body: null };
  try {
    return run(globalThis.window);
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  }
}

function swallowKeys(target) {
  for (const type of ["keydown", "keyup", "beforeinput", "input"]) {
    target.addEventListener(
      type,
      (event) => event.stopImmediatePropagation(),
      true,
    );
  }
}

const arm = (token) => pageScript({ action: "focus", inputProbe: token });
const read = (token, disarm = false) =>
  pageScript({ action: "input_probe", token, disarm });

test("an early recorder counts input that page listeners stop", () => {
  withWindow((page) => {
    inputRecorder(true);
    swallowKeys(page);
    arm("probe-1");

    assert.deepEqual(read("probe-1"), {
      armed: true,
      delivered: false,
      conclusive: true,
      node: null,
    });
    page.dispatchEvent(new TrustedEvent("keydown"));
    assert.equal(read("probe-1").delivered, true);
    // Delivered input removes the probe.
    assert.equal(read("probe-1").armed, false);
  });
});

test("a recorder added after page listeners cannot rule out hidden input", () => {
  withWindow((page) => {
    swallowKeys(page);
    inputRecorder(false);
    arm("probe-2");
    page.dispatchEvent(new TrustedEvent("keydown"));

    const reading = read("probe-2", true);
    assert.equal(reading.delivered, false);
    assert.equal(reading.conclusive, false);
    assert.equal(read("probe-2").armed, false);
  });
});

test("the probe ignores untrusted events and other tokens", () => {
  withWindow((page) => {
    inputRecorder(true);
    inputRecorder(true);
    arm("probe-3");
    page.dispatchEvent(new Event("keydown"));

    assert.equal(read("probe-3").delivered, false);
    assert.equal(read("other").armed, false);
  });
});

test("without a recorder the probe is not armed", () => {
  withWindow(() => {
    arm("probe-4");
    assert.equal(read("probe-4").armed, false);
  });
});
