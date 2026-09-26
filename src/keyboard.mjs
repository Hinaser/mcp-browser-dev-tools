// Key descriptions shared by the CDP (Input.dispatchKeyEvent) and
// WebDriver BiDi (input.performActions) input paths.

const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

function namedKey(key, code, keyCode, webdriver, extra = {}) {
  return { key, code, keyCode, webdriver, ...extra };
}

const NAMED_KEYS = [
  namedKey("Enter", "Enter", 13, "", { text: "\r" }),
  namedKey("Tab", "Tab", 9, ""),
  namedKey("Escape", "Escape", 27, ""),
  namedKey("Backspace", "Backspace", 8, ""),
  namedKey("Delete", "Delete", 46, ""),
  namedKey("Insert", "Insert", 45, ""),
  namedKey("ArrowUp", "ArrowUp", 38, ""),
  namedKey("ArrowDown", "ArrowDown", 40, ""),
  namedKey("ArrowLeft", "ArrowLeft", 37, ""),
  namedKey("ArrowRight", "ArrowRight", 39, ""),
  namedKey("Home", "Home", 36, ""),
  namedKey("End", "End", 35, ""),
  namedKey("PageUp", "PageUp", 33, ""),
  namedKey("PageDown", "PageDown", 34, ""),
  namedKey(" ", "Space", 32, " ", { text: " " }),
  namedKey("Shift", "ShiftLeft", 16, "", { location: 1 }),
  namedKey("Control", "ControlLeft", 17, "", { location: 1 }),
  namedKey("Alt", "AltLeft", 18, "", { location: 1 }),
  namedKey("Meta", "MetaLeft", 91, "", { location: 1 }),
  ...Array.from({ length: 12 }, (_, index) =>
    namedKey(
      `F${index + 1}`,
      `F${index + 1}`,
      112 + index,
      String.fromCharCode(0xe031 + index),
    ),
  ),
];

const KEY_ALIASES = {
  space: " ",
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ctrl: "Control",
  cmd: "Meta",
  command: "Meta",
  option: "Alt",
};

const NAMED_KEYS_BY_NAME = new Map(
  NAMED_KEYS.flatMap((definition) => [
    [definition.key.toLowerCase(), definition],
    [definition.code.toLowerCase(), definition],
  ]),
);

for (const [alias, key] of Object.entries(KEY_ALIASES)) {
  NAMED_KEYS_BY_NAME.set(alias, NAMED_KEYS_BY_NAME.get(key.toLowerCase()));
}

// US layout codes for unshifted punctuation.
const PUNCTUATION = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

// US layout: the character Shift produces for each digit or punctuation key.
const SHIFTED = {
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
};

// Chrome on macOS routes these shortcuts through the app menu, so CDP key
// events alone do not trigger them; they must be sent as editing commands.
const META_EDITING_COMMANDS = {
  KeyA: "selectAll",
  KeyC: "copy",
  KeyX: "cut",
  KeyV: "paste",
  KeyZ: "undo",
};

function describeCharacter(char, shift) {
  const text = shift && /^[a-z]$/.test(char) ? char.toUpperCase() : char;

  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase();
    return {
      key: text,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      webdriver: text,
      text,
    };
  }

  const produced = shift ? (SHIFTED[char] ?? char) : char;

  if (/^[0-9]$/.test(char)) {
    return {
      key: produced,
      code: `Digit${char}`,
      keyCode: char.charCodeAt(0),
      webdriver: produced,
      text: produced,
    };
  }

  const [code, keyCode] = PUNCTUATION[char] ?? ["", 0];
  return {
    key: produced,
    code,
    keyCode,
    webdriver: produced,
    text: produced,
  };
}

function describeKey(name, shift = false) {
  if ([...name].length === 1) {
    return describeCharacter(name, shift);
  }

  const definition = NAMED_KEYS_BY_NAME.get(name.toLowerCase());
  if (!definition) {
    throw new Error(
      `Unsupported key "${name}". Use a single character or a named key such as Enter, Tab, Escape, Backspace, ArrowDown, or F5.`,
    );
  }

  return definition;
}

export function parseKeyCombo(combo) {
  if (typeof combo !== "string" || combo.length === 0) {
    throw new Error("key must be a non-empty string");
  }

  let parts;
  if (combo === "+") {
    parts = ["+"];
  } else if (combo.endsWith("++")) {
    parts = [...combo.slice(0, -2).split("+"), "+"];
  } else {
    parts = combo.split("+");
  }

  const keyName = parts.pop();
  const modifiers = parts.map((part) => {
    const definition = NAMED_KEYS_BY_NAME.get(part.toLowerCase());
    if (!definition || !(definition.key in MODIFIER_BITS)) {
      throw new Error(
        `Unsupported modifier "${part}" in "${combo}". Use Shift, Control, Alt, or Meta.`,
      );
    }
    return definition;
  });

  const shift = modifiers.some((modifier) => modifier.key === "Shift");
  return {
    modifiers,
    key: describeKey(keyName, shift),
  };
}

function cdpKeyParams(type, definition, modifiers, extra = {}) {
  return {
    type,
    modifiers,
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    location: definition.location ?? 0,
    ...extra,
  };
}

export function buildCdpKeyEvents(combo) {
  const { modifiers, key } = parseKeyCombo(combo);
  const events = [];
  let modifierBits = 0;

  for (const modifier of modifiers) {
    modifierBits |= MODIFIER_BITS[modifier.key];
    events.push(cdpKeyParams("rawKeyDown", modifier, modifierBits));
  }

  // Shortcuts (anything beyond Shift) must not insert text.
  const text = modifierBits & ~MODIFIER_BITS.Shift ? "" : (key.text ?? "");
  const extra = text ? { text, unmodifiedText: text } : {};

  const command =
    modifierBits & MODIFIER_BITS.Meta
      ? key.code === "KeyZ" && modifierBits & MODIFIER_BITS.Shift
        ? "redo"
        : META_EDITING_COMMANDS[key.code]
      : null;
  if (command) {
    extra.commands = [command];
  }

  events.push(
    cdpKeyParams(text ? "keyDown" : "rawKeyDown", key, modifierBits, extra),
  );
  events.push(cdpKeyParams("keyUp", key, modifierBits));

  for (const modifier of [...modifiers].reverse()) {
    modifierBits &= ~MODIFIER_BITS[modifier.key];
    events.push(cdpKeyParams("keyUp", modifier, modifierBits));
  }

  return events;
}

export function buildBidiKeyActions(combo) {
  const { modifiers, key } = parseKeyCombo(combo);
  return [
    ...modifiers.map((modifier) => ({
      type: "keyDown",
      value: modifier.webdriver,
    })),
    { type: "keyDown", value: key.webdriver },
    { type: "keyUp", value: key.webdriver },
    ...[...modifiers].reverse().map((modifier) => ({
      type: "keyUp",
      value: modifier.webdriver,
    })),
  ];
}

export function buildBidiTextActions(text) {
  const enter = NAMED_KEYS_BY_NAME.get("enter").webdriver;
  return [...text.replace(/\r\n?/g, "\n")].flatMap((char) => {
    const value = char === "\n" ? enter : char;
    return [
      { type: "keyDown", value },
      { type: "keyUp", value },
    ];
  });
}
