import assert from "node:assert/strict";
import test from "node:test";

import { formatSnapshotResult } from "./inspection-tools.mjs";

test("get_snapshot returns its nodes as plain lines and keeps the structured result", () => {
  const result = {
    url: "https://example.com/signup",
    title: "Sign up",
    found: true,
    nodes: ['e1 h1 "Sign up"', 'e2 button "Save"'],
    more: 3,
  };

  const formatted = formatSnapshotResult(result);

  assert.deepEqual(formatted.content, [
    {
      type: "text",
      text: [
        'https://example.com/signup "Sign up"',
        'e1 h1 "Sign up"',
        'e2 button "Save"',
        "(3 more nodes; raise limit or pass a selector)",
      ].join("\n"),
    },
  ]);
  assert.equal(formatted.structuredContent, result);
});

test("get_snapshot reports a missing selector as JSON like other tools", () => {
  const result = { found: false, selector: "#nope" };
  const formatted = formatSnapshotResult(result);
  assert.equal(formatted.content[0].text, JSON.stringify(result, null, 2));
});
