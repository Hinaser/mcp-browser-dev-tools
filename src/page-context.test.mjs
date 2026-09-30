import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  assertEnabled,
  assertPointerTarget,
  buildPageContextExpression,
  ELEMENT_NOT_ACTIONABLE,
} from "./page-context.mjs";

class FakeHTMLElement {
  constructor({
    tagName = "div",
    attrs = {},
    textContent = "",
    innerText = textContent,
    outerHTML = null,
    rect = null,
    style = {},
    childElementCount = 0,
  } = {}) {
    this.tagName = tagName.toUpperCase();
    this._attrs = { ...attrs };
    this.attributes = Object.entries(this._attrs).map(([name, value]) => ({
      name,
      value,
    }));
    this.textContent = textContent;
    this.innerText = innerText;
    this.outerHTML = outerHTML ?? `<${tagName}>${textContent}</${tagName}>`;
    this.childElementCount = childElementCount;
    this.hidden = false;
    this.disabled = false;
    this.isContentEditable = false;
    this.tabIndex = -1;
    this.onclick = null;
    this.scrollHeight = 100;
    this.clientHeight = 50;
    this.scrollWidth = 100;
    this.clientWidth = 50;
    this._rect = rect ?? {
      x: 10,
      y: 20,
      width: 120,
      height: 40,
      top: 20,
      right: 130,
      bottom: 60,
      left: 10,
    };
    this._style = {
      display: "block",
      visibility: "visible",
      pointerEvents: "auto",
      position: "static",
      zIndex: "auto",
      overflowX: "visible",
      overflowY: "visible",
      opacity: "1",
      ...style,
    };
    this.clickCount = 0;
    this.scrollIntoViewCount = 0;
    this.dispatchEvents = [];
    this.parentNode = null;
  }

  getAttribute(name) {
    return this._attrs[name] ?? null;
  }

  hasAttribute(name) {
    return Object.hasOwn(this._attrs, name);
  }

  getBoundingClientRect() {
    return this._rect;
  }

  scrollIntoView() {
    this.scrollIntoViewCount += 1;
  }

  focus() {
    if (this._document) {
      this._document.activeElement = this;
    }
  }

  click() {
    this.clickCount += 1;
  }

  dispatchEvent(event) {
    this.dispatchEvents.push(event.type);
    return true;
  }
}

class FakeHTMLInputElement extends FakeHTMLElement {
  constructor(options = {}) {
    super({ tagName: "input", ...options });
    this.type = options.type ?? "text";
    this._value = options.value ?? "";
    this.selection = null;
  }

  get value() {
    return this._value;
  }

  set value(next) {
    this._value = next;
  }

  select() {
    this.selection = [0, this._value.length];
  }

  setSelectionRange(start, end) {
    this.selection = [start, end];
  }
}
class FakeHTMLTextAreaElement extends FakeHTMLElement {}
class FakeHTMLSelectElement extends FakeHTMLElement {}

function createPageContext({
  body,
  descendants = [],
  selectorMap = {},
  hit = null,
}) {
  const document = {
    title: "Example",
    readyState: "complete",
    visibilityState: "visible",
    body,
    activeElement: body,
    querySelector(selector) {
      return selectorMap[selector] ?? null;
    },
    querySelectorAll(selector) {
      if (selector === "body *") {
        return descendants;
      }

      return selectorMap[selector] ? [selectorMap[selector]] : [];
    },
    elementFromPoint() {
      return hit;
    },
    getElementById(id) {
      return (
        descendants.find((element) => element.getAttribute("id") === id) ?? null
      );
    },
  };

  for (const element of [body, ...descendants]) {
    element._document = document;
  }

  return vm.createContext({
    document,
    window: {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      pageXOffset: 0,
      pageYOffset: 0,
      scrollBy() {},
    },
    location: {
      href: "https://example.com/profile",
    },
    performance: {
      getEntriesByType() {
        return [];
      },
    },
    getComputedStyle(element) {
      return element._style;
    },
    CSS: {
      escape(value) {
        return value;
      },
    },
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    HTMLSelectElement: FakeHTMLSelectElement,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MouseEvent: class MouseEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    JSON,
  });
}

test("inspect results stay serializable when a selector resolves successfully", () => {
  const button = new FakeHTMLElement({
    tagName: "button",
    attrs: { class: "cta" },
    textContent: "プランを見る",
    innerText: "プランを見る",
    outerHTML: '<button class="cta">プランを見る</button>',
  });
  const body = new FakeHTMLElement({
    tagName: "body",
    childElementCount: 1,
    outerHTML: "<body></body>",
  });

  const context = createPageContext({
    body,
    descendants: [button],
    selectorMap: {
      body,
    },
  });

  const expression = buildPageContextExpression(
    {
      browserFamily: "chromium",
      action: "inspect",
      selector: "text=プランを見る",
    },
    { serialize: true },
  );

  const result = JSON.parse(vm.runInContext(expression, context));

  assert.equal(result.found, true);
  assert.equal(result.node.tagName, "BUTTON");
  assert.deepEqual(result.node.locator, {
    locator: "text=プランを見る",
    strategy: "text",
    query: "プランを見る",
  });
  assert.equal("element" in result.node.locator, false);
});

function runAction(context, payload) {
  return JSON.parse(
    vm.runInContext(
      buildPageContextExpression(
        { browserFamily: "chromium", ...payload },
        { serialize: true },
      ),
      context,
    ),
  );
}

test("inspect answers text checks against the full text, not the clipped node text", () => {
  const long = `${"Order ".repeat(100)}  Paid\n in full`;
  const status = new FakeHTMLElement({
    tagName: "div",
    textContent: long,
    innerText: long,
  });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [status],
    selectorMap: { "#status": status },
  });

  const result = runAction(context, {
    action: "inspect",
    selector: "#status",
    textChecks: [
      { textIncludes: "Paid in full", textEquals: null, textExcludes: null },
      { textExcludes: "Processing", textEquals: null, textIncludes: null },
      { textExcludes: "Paid", textEquals: null, textIncludes: null },
      {
        textEquals: `${"Order ".repeat(100)}Paid in full`,
        textIncludes: null,
        textExcludes: null,
      },
    ],
  });

  assert.equal(result.node.innerText.endsWith("..."), true);
  assert.deepEqual(result.textMatches, [true, true, false, true]);
  assert.equal(
    "textMatches" in
      runAction(context, { action: "inspect", selector: "#status" }),
    false,
  );
});

function createButtonPage({ hit } = {}) {
  const button = new FakeHTMLElement({
    tagName: "button",
    attrs: { class: "cta" },
    textContent: "View plan",
  });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [button],
    selectorMap: { "button.cta": button },
    hit: hit === undefined ? button : hit(button),
  });
  return { button, context };
}

test("pointer_target scrolls the element into view and returns its center", () => {
  const { button, context } = createButtonPage();

  const result = runAction(context, {
    action: "pointer_target",
    selector: "button.cta",
  });

  assert.equal(result.found, true);
  assert.deepEqual(result.point, { x: 70, y: 40 });
  assert.equal(result.receivesEvents, true);
  assert.equal(result.obscuredBy, null);
  assert.equal(button.scrollIntoViewCount, 1);
  assert.equal(button.clickCount, 0);
  assert.doesNotThrow(() => assertPointerTarget(result));
});

test("pointer_target accepts hits on descendants of the element", () => {
  const { context } = createButtonPage({
    hit: (button) => {
      const icon = new FakeHTMLElement({ tagName: "svg" });
      icon.parentNode = button;
      return icon;
    },
  });

  const result = runAction(context, {
    action: "pointer_target",
    selector: "button.cta",
  });

  assert.equal(result.receivesEvents, true);
});

test("pointer_target reports the element covering the click point", () => {
  const { context } = createButtonPage({
    hit: () =>
      new FakeHTMLElement({
        tagName: "div",
        attrs: { id: "cookie-banner", class: "overlay modal" },
      }),
  });

  const result = runAction(context, {
    action: "pointer_target",
    selector: "button.cta",
  });

  assert.equal(result.receivesEvents, false);
  assert.deepEqual(result.obscuredBy, {
    tagName: "DIV",
    id: "cookie-banner",
    className: "overlay modal",
  });
  assert.throws(
    () => assertPointerTarget(result),
    /covered by <div#cookie-banner\.overlay\.modal> at \(70, 40\)/,
  );
});

test("pointer_target reports elements without a visible area", () => {
  const { context } = createButtonPage();
  context.window.innerWidth = 0;

  const result = runAction(context, {
    action: "pointer_target",
    selector: "button.cta",
  });

  assert.equal(result.point, null);
  assert.throws(() => assertPointerTarget(result), /no visible area/);
});

function createInputPage(options) {
  const input = new FakeHTMLInputElement(options);
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [input],
    selectorMap: { "#field": input },
  });
  return { input, context };
}

test("prepare_type focuses a text input and selects its value for replacement", () => {
  const { input, context } = createInputPage({ value: "old" });

  const result = runAction(context, {
    action: "prepare_type",
    selector: "#field",
    text: "new",
  });

  assert.equal(result.method, "native");
  assert.equal(context.document.activeElement, input);
  assert.deepEqual(input.selection, [0, 3]);
  assert.equal(input.value, "old");
  assert.deepEqual(input.dispatchEvents, []);
});

test("prepare_type moves the caret to the end when clear is false", () => {
  const { input, context } = createInputPage({ value: "old" });

  runAction(context, {
    action: "prepare_type",
    selector: "#field",
    text: "new",
    clear: false,
  });

  assert.deepEqual(input.selection, [3, 3]);
});

test("prepare_type sets picker values through the prototype setter", () => {
  const { input, context } = createInputPage({ type: "date" });
  // React shadows value on the instance to track changes; writing through
  // it would hide the change from React's onChange.
  let trackedWrites = 0;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return this._value;
    },
    set(next) {
      trackedWrites += 1;
      this._value = next;
    },
  });

  const result = runAction(context, {
    action: "prepare_type",
    selector: "#field",
    text: "2026-09-27",
  });

  assert.equal(result.method, "value");
  assert.equal(input._value, "2026-09-27");
  assert.equal(trackedWrites, 0);
  assert.deepEqual(input.dispatchEvents, ["input", "change"]);
});

test("prepare_type rejects elements that are not editable", () => {
  const { context } = createButtonPage();

  assert.throws(
    () =>
      runAction(context, {
        action: "prepare_type",
        selector: "button.cta",
        text: "x",
      }),
    /not editable/,
  );
});

test("focus reports the focused element after focusing the selector", () => {
  const { context } = createInputPage({ attrs: { id: "field" } });

  const result = runAction(context, { action: "focus", selector: "#field" });

  assert.deepEqual(result.target, {
    tagName: "INPUT",
    id: "field",
    className: null,
  });
});

test("select picks the option matching the label and fires change events", () => {
  const select = new FakeHTMLSelectElement({ tagName: "select" });
  select.options = [
    { value: "us", text: "United States" },
    { value: "jp", text: "Japan" },
  ];
  select.value = "us";
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [select],
    selectorMap: { "#country": select },
  });

  const result = runAction(context, {
    action: "select",
    selector: "#country",
    label: "Japan",
  });

  assert.equal(result.selectedValue, "jp");
  assert.equal(select.value, "jp");
  assert.deepEqual(select.dispatchEvents, ["input", "change"]);
});

test("focus refuses to report success when the selector cannot take focus", () => {
  const { button, context } = createButtonPage();
  button.focus = () => {};

  assert.throws(
    () => runAction(context, { action: "focus", selector: "button.cta" }),
    /Could not focus/,
  );
});

test("pointer and disabled errors are marked as retryable", () => {
  assert.throws(
    () =>
      assertPointerTarget({
        found: true,
        selector: "#save",
        point: { x: 1, y: 1 },
        receivesEvents: false,
        obscuredBy: null,
      }),
    (error) => error.code === ELEMENT_NOT_ACTIONABLE,
  );
  assert.throws(
    () =>
      assertEnabled({
        found: true,
        selector: "#save",
        node: { disabled: true },
      }),
    (error) =>
      error.code === ELEMENT_NOT_ACTIONABLE &&
      error.message === 'Element "#save" is disabled',
  );
  assertEnabled({ found: true, selector: "#save", node: { disabled: false } });
  assertEnabled({ found: false, selector: "#save" });
});

test("controls_snapshot lists visible controls with locators the tools accept", () => {
  const save = new FakeHTMLElement({
    tagName: "button",
    attrs: { id: "save" },
    textContent: "Save",
  });
  const email = new FakeHTMLInputElement({
    attrs: { name: "email" },
    value: "ada@example.com",
  });
  const terms = new FakeHTMLInputElement({
    type: "checkbox",
    attrs: { type: "checkbox", name: "terms", "aria-label": "Accept terms" },
  });
  const submit = new FakeHTMLElement({
    tagName: "button",
    textContent: "Create account",
  });
  submit.disabled = true;
  const hidden = new FakeHTMLElement({
    tagName: "button",
    textContent: "Hidden",
  });
  hidden.hidden = true;
  const text = new FakeHTMLElement({ tagName: "p", textContent: "Welcome" });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [save, email, terms, submit, hidden, text],
    selectorMap: { "#save": save, 'input[name="email"]': email },
  });

  const result = runAction(context, { action: "controls_snapshot" });

  assert.equal(result.url, "https://example.com/profile");
  assert.equal(result.title, "Example");
  assert.equal(result.moreControls, 0);
  assert.deepEqual(result.controls, [
    { locator: "#save", role: "button", name: "Save" },
    {
      locator: 'input[name="email"]',
      role: "textbox",
      value: "ada@example.com",
    },
    {
      locator: 'role=checkbox[name="Accept terms"]',
      role: "checkbox",
      name: "Accept terms",
      checked: false,
    },
    {
      locator: 'role=button[name="Create account"]',
      role: "button",
      name: "Create account",
      disabled: true,
    },
  ]);
});

test("a wrapping label names its control, without the control's own text", () => {
  const email = new FakeHTMLInputElement({
    attrs: { name: "email" },
    value: "on",
  });
  const plan = new FakeHTMLSelectElement({
    tagName: "select",
    textContent: "Choose a plan Free Pro",
  });
  const emailLabel = new FakeHTMLElement({ tagName: "label" });
  emailLabel.childNodes = [{ nodeType: 3, textContent: " Email " }, email];
  const planLabel = new FakeHTMLElement({ tagName: "label" });
  planLabel.childNodes = [{ nodeType: 3, textContent: "Plan" }, plan];
  email.closest = (selector) => (selector === "label" ? emailLabel : null);
  plan.closest = (selector) => (selector === "label" ? planLabel : null);
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [emailLabel, email, planLabel, plan],
  });

  const result = runAction(context, {
    action: "inspect",
    selector: 'role=textbox[name="Email"]',
  });
  assert.equal(result.found, true);
  assert.equal(result.node.accessibleName, "Email");

  const snapshot = runAction(context, { action: "controls_snapshot" });
  assert.deepEqual(
    snapshot.controls.map((control) => control.name),
    ["Email", "Plan"],
  );
});

test("controls_snapshot only suggests locators that resolve back to the control", () => {
  const draft = new FakeHTMLElement({
    tagName: "button",
    textContent: "Save draft",
  });
  const save = new FakeHTMLElement({ tagName: "button", textContent: "Save" });
  const decoy = new FakeHTMLInputElement({ attrs: { name: "ab" } });
  const field = new FakeHTMLInputElement({
    attrs: { name: "a\\b", "aria-label": "Code" },
  });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [draft, save, decoy, field],
    // The fake CSS.escape leaves the backslash alone, so this selector
    // stands in for one that matches a different field.
    selectorMap: { 'input[name="a\\b"]': decoy, 'input[name="ab"]': decoy },
  });

  const { controls } = runAction(context, { action: "controls_snapshot" });

  assert.deepEqual(
    controls.map((control) => control.locator),
    [
      'role=button[name="Save draft"]',
      null,
      'input[name="ab"]',
      'role=textbox[name="Code"]',
    ],
  );
});

test("a nested wrapping label still names its control", () => {
  const email = new FakeHTMLInputElement({ attrs: { name: "email" } });
  const span = new FakeHTMLElement({ tagName: "span" });
  span.nodeType = 1;
  span.childNodes = [{ nodeType: 3, textContent: "Email " }, email];
  span.contains = (node) => node === email;
  const label = new FakeHTMLElement({ tagName: "label" });
  label.childNodes = [span];
  email.closest = (selector) => (selector === "label" ? label : null);
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [label, email] });

  const result = runAction(context, {
    action: "inspect",
    selector: 'role=textbox[name="Email"]',
  });
  assert.equal(result.found, true);
});

test("elements matching :disabled count as disabled", () => {
  const button = new FakeHTMLElement({
    tagName: "button",
    attrs: { id: "go" },
    textContent: "Go",
  });
  button.matches = (selector) => selector === ":disabled";
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [button],
    selectorMap: { "#go": button },
  });

  const result = runAction(context, { action: "inspect", selector: "#go" });
  assert.equal(result.node.disabled, true);
});

test("controls_snapshot never reports a password's value", () => {
  const password = new FakeHTMLInputElement({
    type: "password",
    attrs: { type: "password", name: "password", value: "hunter2" },
    value: "hunter2",
  });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [password],
    selectorMap: { 'input[name="password"]': password },
  });

  const result = runAction(context, { action: "controls_snapshot" });
  assert.deepEqual(result.controls, [
    { locator: 'input[name="password"]', role: "textbox" },
  ]);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
});

test("wrapping label text keeps the page's own spacing", () => {
  const email = new FakeHTMLInputElement({ attrs: { name: "email" } });
  const span = new FakeHTMLElement({ tagName: "span", textContent: "mail" });
  span.nodeType = 1;
  span.contains = () => false;
  const label = new FakeHTMLElement({ tagName: "label" });
  label.childNodes = [{ nodeType: 3, textContent: "E" }, span, email];
  email.closest = (selector) => (selector === "label" ? label : null);
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [label, email] });

  const result = runAction(context, {
    action: "inspect",
    selector: 'role=textbox[name="Email"]',
  });
  assert.equal(result.found, true);
  assert.equal(result.node.accessibleName, "Email");
});

test("name= skips a label that belongs to a control and finds the control", () => {
  const input = new FakeHTMLInputElement({ attrs: { name: "username" } });
  const label = new FakeHTMLElement({
    tagName: "label",
    textContent: "Username",
  });
  label.control = input;
  label.childNodes = [{ nodeType: 3, textContent: "Username" }, input];
  input.closest = (selector) => (selector === "label" ? label : null);
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [label, input] });

  const result = runAction(context, {
    action: "inspect",
    selector: "name=Username",
  });
  assert.equal(result.node.tagName, "INPUT");
  // A hidden input, as styled checkboxes use, leaves the label to click.
  input.hidden = true;
  const hidden = runAction(context, {
    action: "inspect",
    selector: "name=Username",
  });
  assert.equal(hidden.node.tagName, "LABEL");
});

function readText(context, payload) {
  return JSON.parse(
    vm.runInContext(
      buildPageContextExpression(
        {
          browserFamily: "chromium",
          action: "read_text",
          maxChars: 8000,
          ...payload,
        },
        { serialize: true },
      ),
      context,
    ),
  );
}

test("read_text reads the body as lines with runs of spaces and blank lines collapsed", () => {
  const body = new FakeHTMLElement({
    tagName: "body",
    innerText: "  Title \n\n\n\n Line \t two  end \nlast",
  });
  const result = readText(createPageContext({ body }), {});

  assert.equal(result.source, "body");
  assert.equal(result.text, "Title\n\nLine two end\nlast");
  assert.equal(result.totalChars, result.text.length);
  assert.equal(result.truncated, false);
  assert.equal(result.url, "https://example.com/profile");
  assert.equal(result.title, "Example");
});

test("read_text prefers the main content and clips to maxChars", () => {
  const main = new FakeHTMLElement({
    tagName: "main",
    innerText: "Article text that is long",
  });
  const body = new FakeHTMLElement({
    tagName: "body",
    innerText: "Menu\nArticle text that is long\nFooter",
  });
  const context = createPageContext({
    body,
    descendants: [main],
    selectorMap: { "main, [role=main]": main },
  });

  const result = readText(context, { maxChars: 7 });
  assert.equal(result.source, "main");
  assert.equal(result.text, "Article");
  assert.equal(result.totalChars, 25);
  assert.equal(result.truncated, true);
});

test("read_text reports a missing selector as not found", () => {
  const body = new FakeHTMLElement({ tagName: "body", innerText: "x" });
  const result = readText(createPageContext({ body }), {
    selector: "#missing",
  });
  assert.equal(result.found, false);
  assert.equal(result.selector, "#missing");
});

test("read_text reads an element that ignores the pointer", () => {
  const overlay = new FakeHTMLElement({
    tagName: "div",
    innerText: "Status: saved",
    style: { pointerEvents: "none" },
  });
  const body = new FakeHTMLElement({ tagName: "body", innerText: "x" });
  const context = createPageContext({
    body,
    descendants: [overlay],
    selectorMap: { "#status": overlay },
  });

  const result = readText(context, { selector: "#status" });
  assert.equal(result.visible, true);
  assert.equal(result.text, "Status: saved");
});

test("read_text returns no text for a hidden element", () => {
  const hidden = new FakeHTMLElement({
    tagName: "div",
    attrs: { id: "secret" },
    innerText: "not shown",
    style: { display: "none" },
  });
  const body = new FakeHTMLElement({ tagName: "body", innerText: "shown" });
  const context = createPageContext({
    body,
    descendants: [hidden],
    selectorMap: { "#secret": hidden },
  });

  const result = readText(context, { selector: "#secret" });
  assert.equal(result.found, true);
  assert.equal(result.visible, false);
  assert.equal(result.text, "");
});
