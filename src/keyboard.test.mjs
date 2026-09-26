import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBidiKeyActions,
  buildBidiTextActions,
  buildCdpKeyEvents,
  parseKeyCombo,
} from "./keyboard.mjs";

test("buildCdpKeyEvents sends Enter with a carriage return so forms submit", () => {
  assert.deepEqual(buildCdpKeyEvents("Enter"), [
    {
      type: "keyDown",
      modifiers: 0,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      location: 0,
      text: "\r",
      unmodifiedText: "\r",
    },
    {
      type: "keyUp",
      modifiers: 0,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      location: 0,
    },
  ]);
});

test("buildCdpKeyEvents wraps the key in modifier presses", () => {
  const events = buildCdpKeyEvents("Shift+Tab");

  assert.deepEqual(
    events.map(({ type, key, modifiers }) => [type, key, modifiers]),
    [
      ["rawKeyDown", "Shift", 8],
      ["rawKeyDown", "Tab", 8],
      ["keyUp", "Tab", 8],
      ["keyUp", "Shift", 0],
    ],
  );
});

test("buildCdpKeyEvents sends shortcuts without text and with editing commands", () => {
  const keyDown = buildCdpKeyEvents("Meta+a")[1];

  assert.equal(keyDown.type, "rawKeyDown");
  assert.equal(keyDown.code, "KeyA");
  assert.equal(keyDown.text, undefined);
  assert.deepEqual(keyDown.commands, ["selectAll"]);
  assert.deepEqual(buildCdpKeyEvents("Meta+Shift+z")[2].commands, ["redo"]);
});

test("buildCdpKeyEvents uppercases letters pressed with Shift", () => {
  const keyDown = buildCdpKeyEvents("Shift+a")[1];

  assert.equal(keyDown.key, "A");
  assert.equal(keyDown.text, "A");
});

test("parseKeyCombo accepts aliases, case-insensitive names, and a literal plus", () => {
  assert.equal(parseKeyCombo("esc").key.key, "Escape");
  assert.equal(parseKeyCombo("arrowdown").key.key, "ArrowDown");
  assert.equal(parseKeyCombo("Space").key.key, " ");
  assert.deepEqual(
    parseKeyCombo("Ctrl++").modifiers.map((modifier) => modifier.key),
    ["Control"],
  );
  assert.equal(parseKeyCombo("Ctrl++").key.key, "+");
});

test("parseKeyCombo rejects unknown keys and modifiers", () => {
  assert.throws(() => parseKeyCombo("Hyper"), /Unsupported key "Hyper"/);
  assert.throws(() => parseKeyCombo("Enter+a"), /Unsupported modifier "Enter"/);
  assert.throws(() => parseKeyCombo(""), /non-empty/);
});

test("buildBidiKeyActions uses WebDriver key codes", () => {
  assert.deepEqual(buildBidiKeyActions("Control+Enter"), [
    { type: "keyDown", value: "" },
    { type: "keyDown", value: "" },
    { type: "keyUp", value: "" },
    { type: "keyUp", value: "" },
  ]);
});

test("buildBidiTextActions types each character and maps newlines to Enter", () => {
  assert.deepEqual(
    buildBidiTextActions("a\r\n😀").map((action) => action.value),
    ["a", "a", "", "", "😀", "😀"],
  );
});

test("Shift with digits and punctuation produces the US shifted character", () => {
  const keyDown = buildCdpKeyEvents("Shift+2")[1];

  assert.equal(keyDown.key, "@");
  assert.equal(keyDown.text, "@");
  assert.equal(keyDown.code, "Digit2");
  assert.equal(buildBidiKeyActions("Shift+/")[1].value, "?");
});
