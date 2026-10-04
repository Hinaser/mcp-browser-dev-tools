import assert from "node:assert/strict";
import test from "node:test";

import {
  FrameKeys,
  addFrameSnapshots,
  parseFrameRef,
  prefixFrameReport,
  restoreFrameSelector,
  shiftFramePoints,
} from "./page-context.mjs";

test("frame refs name a frame and an element in it", () => {
  assert.deepEqual(parseFrameRef("ref=f2e17"), {
    frameKey: "f2",
    selector: "ref=e17",
  });
  assert.equal(parseFrameRef("ref=e3"), null);
  assert.equal(parseFrameRef("#save"), null);
  assert.equal(parseFrameRef(undefined), null);
});

test("frame keys stay with their frame and keep its next ref", () => {
  const keys = new FrameKeys();
  assert.equal(keys.keyFor("frame-a", { url: "https://a" }), "f1");
  assert.equal(keys.keyFor("frame-b", { url: "https://b" }), "f2");
  keys.get("f1").refStart = 9;
  assert.equal(keys.keyFor("frame-a", { url: "https://a/next" }), "f1");
  assert.equal(keys.get("f1").refStart, 9);
  assert.equal(keys.get("f1").url, "https://a/next");
  assert.equal(keys.get("f3"), null);
});

test("points from a frame move into the top page's viewport", () => {
  const shifted = shiftFramePoints(
    {
      point: { x: 10, y: 5 },
      node: {
        box: {
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          left: 1,
          top: 2,
          right: 4,
          bottom: 6,
        },
      },
    },
    { x: 100, y: 50 },
  );
  assert.deepEqual(shifted.point, { x: 110, y: 55 });
  assert.deepEqual(shifted.node.box, {
    x: 101,
    y: 52,
    width: 3,
    height: 4,
    left: 101,
    top: 52,
    right: 104,
    bottom: 56,
  });
});

test("results and reports from a frame carry the frame in their refs and selector", () => {
  const route = parseFrameRef("ref=f2e3");
  assert.deepEqual(
    restoreFrameSelector(
      { selector: "ref=e3", found: true },
      route,
      "ref=f2e3",
    ),
    { selector: "ref=f2e3", found: true },
  );
  assert.deepEqual(
    prefixFrameReport(
      {
        added: { lines: ['e4 button "Retry"'], more: 0 },
        updated: { lines: ['e3 textbox "Name" value="Bob"'], more: 0 },
        removed: { lines: [], more: 0 },
      },
      "f2",
    ),
    {
      added: { lines: ['f2e4 button "Retry"'], more: 0 },
      updated: { lines: ['f2e3 textbox "Name" value="Bob"'], more: 0 },
      removed: { lines: [], more: 0 },
    },
  );
});

test("frame snapshots follow the top page's, skipping empty and hidden frames", async () => {
  const keys = new FrameKeys();
  const answers = {
    "frame-a": {
      found: true,
      url: "https://a/form",
      title: "Form",
      nodes: ['e1 textbox "Name" value=""'],
      more: 0,
      nextRef: 2,
    },
    "frame-ads": {
      found: true,
      url: "about:blank",
      title: "",
      nodes: [],
      more: 0,
    },
    "frame-hidden": { found: false, error: "Unknown frame" },
  };
  const result = await addFrameSnapshots({
    result: { found: true, nodes: ['e1 h1 "Checkout"'] },
    frames: [
      { id: "frame-a", url: "https://a/form" },
      { id: "frame-ads", url: "about:blank" },
      { id: "frame-hidden", url: "https://h" },
    ],
    frameKeys: keys,
    runInFrame: async (key) => answers[keys.get(key).id],
    options: { limit: 100, headings: true },
  });
  assert.deepEqual(result.nodes, [
    'e1 h1 "Checkout"',
    'f1 frame "Form" https://a/form',
    'f1e1 textbox "Name" value=""',
  ]);
  assert.equal(keys.get("f1").refStart, 2);
});
