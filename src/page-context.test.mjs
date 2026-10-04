import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  assertEnabled,
  assertPointerTarget,
  buildPageContextExpression,
  ELEMENT_NOT_ACTIONABLE,
  takeNextRef,
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
    this.isConnected = true;
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
    { ref: "e1", locator: "#save", role: "button", name: "Save" },
    {
      ref: "e2",
      locator: 'input[name="email"]',
      role: "textbox",
      value: "ada@example.com",
    },
    {
      ref: "e3",
      locator: 'role=checkbox[name="Accept terms"]',
      role: "checkbox",
      name: "Accept terms",
      checked: false,
    },
    {
      ref: "e4",
      locator: 'role=button[name="Create account"]',
      role: "button",
      name: "Create account",
      disabled: true,
    },
  ]);
});

function snapshotFixture() {
  const heading = new FakeHTMLElement({
    tagName: "h1",
    textContent: "Sign up",
  });
  const email = new FakeHTMLInputElement({
    attrs: { name: "email", "aria-label": "Email" },
    value: "ada@example.com",
  });
  const terms = new FakeHTMLInputElement({
    type: "checkbox",
    attrs: { type: "checkbox", "aria-label": "Accept terms" },
  });
  terms.checked = true;
  const submit = new FakeHTMLElement({
    tagName: "button",
    textContent: "Create account",
  });
  submit.disabled = true;
  const footer = new FakeHTMLElement({ tagName: "footer" });
  const help = new FakeHTMLElement({
    tagName: "a",
    attrs: { href: "/help" },
    textContent: "Help",
  });
  footer.querySelectorAll = () => [help];
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [heading, email, terms, submit, footer, help],
    selectorMap: { footer },
  });
  return { context, heading, email, terms, submit, help };
}

test("snapshot lists headings and controls as lines with refs", () => {
  const { context } = snapshotFixture();

  const result = runAction(context, { action: "snapshot" });

  assert.equal(result.found, true);
  assert.equal(result.url, "https://example.com/profile");
  assert.equal(result.more, 0);
  assert.deepEqual(result.nodes, [
    'e1 h1 "Sign up"',
    'e2 textbox "Email" value="ada@example.com"',
    'e3 checkbox "Accept terms" checked',
    'e4 button "Create account" disabled',
    'e5 link "Help"',
  ]);
});

test("snapshot keeps an element's ref between calls and resolves ref= locators", () => {
  const { context, email } = snapshotFixture();

  const first = runAction(context, { action: "snapshot" });
  const second = runAction(context, { action: "snapshot", headings: false });
  assert.equal(second.nodes[0], first.nodes[1]);

  const inspected = runAction(context, {
    action: "inspect",
    selector: "ref=e2",
  });
  assert.equal(inspected.found, true);
  assert.equal(inspected.node.accessibleName, "Email");

  const unknown = runAction(context, {
    action: "inspect",
    selector: "ref=e99",
  });
  assert.equal(unknown.found, false);
  assert.match(unknown.error, /Unknown ref e99/);

  email.isConnected = false;
  const stale = runAction(context, { action: "inspect", selector: "ref=e2" });
  assert.equal(stale.found, false);
  assert.match(stale.error, /Stale ref e2/);
});

test("snapshot numbers refs from refStart, so an earlier page's refs never resolve", () => {
  const { context } = snapshotFixture();

  const result = runAction(context, { action: "snapshot", refStart: 7 });
  assert.equal(result.nodes[0], 'e7 h1 "Sign up"');
  assert.equal(result.nextRef, 12);

  const old = runAction(context, { action: "inspect", selector: "ref=e1" });
  assert.equal(old.found, false);
  assert.match(old.error, /Unknown ref e1/);

  // A lower refStart (the same page seen again) never rewinds the counter.
  const again = runAction(context, { action: "snapshot", refStart: 1 });
  assert.equal(again.nodes[0], 'e7 h1 "Sign up"');
  assert.equal(again.nextRef, 12);
});

test("snapshot drops elements that left the document from the registry", () => {
  const { context, email } = snapshotFixture();
  runAction(context, { action: "snapshot" });

  // The fixture's querySelectorAll still returns the detached element, as a
  // real document would not; the check is only that the old ref is dropped.
  email.isConnected = false;
  runAction(context, { action: "snapshot", headings: false });

  const gone = runAction(context, { action: "inspect", selector: "ref=e2" });
  assert.equal(gone.found, false);
  assert.match(gone.error, /Unknown ref e2/);
});

test("snapshot names a heading by its accessible name", () => {
  const heading = new FakeHTMLElement({
    tagName: "h2",
    attrs: { "aria-label": "Billing" },
    textContent: "Step 2",
  });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [heading] });

  const result = runAction(context, { action: "snapshot" });
  assert.deepEqual(result.nodes, ['e1 h2 "Billing"']);
});

test("takeNextRef moves the page's next ref onto the session and off the result", () => {
  const session = {};
  assert.deepEqual(takeNextRef(session, { nodes: [], nextRef: 9 }), {
    nodes: [],
  });
  assert.equal(session.refStart, 9);

  assert.deepEqual(takeNextRef(session, { nodes: [], nextRef: 4 }), {
    nodes: [],
  });
  assert.equal(session.refStart, 9);

  const missing = { found: false };
  assert.equal(takeNextRef(session, missing), missing);
});

test("snapshot honours limit and selector", () => {
  const { context } = snapshotFixture();

  const limited = runAction(context, { action: "snapshot", limit: 2 });
  assert.equal(limited.nodes.length, 2);
  assert.equal(limited.more, 3);

  const scoped = runAction(context, {
    action: "snapshot",
    selector: "footer",
  });
  assert.deepEqual(scoped.nodes, ['e3 link "Help"']);

  const missing = runAction(context, {
    action: "snapshot",
    selector: "#nope",
  });
  assert.equal(missing.found, false);
  assert.equal(missing.nodes, undefined);
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
    {
      ref: "e1",
      locator: 'input[name="password"]',
      role: "textbox",
      filled: true,
    },
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

// Stands in for the page's MutationObserver; the test delivers records.
function installFakeMutationObserver(context) {
  const observers = [];
  context.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.pending = [];
      this.connected = false;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
    takeRecords() {
      const records = this.pending;
      this.pending = [];
      return records;
    }
  };
  context.setTimeout = () => 0;
  context.clearTimeout = () => {};
  // Queues records as the browser does before the callback runs.
  return (records) => {
    for (const observer of observers) {
      if (observer.connected) {
        observer.pending.push(...records);
      }
    }
  };
}

test("change_report diffs controls against the baseline and lists added text", () => {
  const { context, email, terms, submit } = snapshotFixture();
  const mutate = installFakeMutationObserver(context);
  const descendants = context.document.querySelectorAll("body *");

  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c1",
  });
  assert.equal(typeof documentId, "string");
  const ids = { changeId: "c1", documentId };

  email.value = "grace@example.com";
  terms.checked = false;
  submit.isConnected = false;
  descendants.splice(descendants.indexOf(submit), 1);
  const retry = new FakeHTMLElement({
    tagName: "button",
    textContent: "Retry",
  });
  retry.nodeType = 1;
  const error = new FakeHTMLElement({
    tagName: "p",
    textContent: "Card declined",
  });
  error.nodeType = 1;
  descendants.push(retry, error);
  mutate([{ type: "childList", addedNodes: [retry, error] }]);

  const status = runAction(context, { action: "change_status", ...ids });
  assert.equal(status.document, "same");
  assert.equal(typeof status.quietMs, "number");

  const report = runAction(context, { action: "change_report", ...ids });
  assert.equal(report.newDocument, false);
  assert.equal(report.urlChanged, false);
  assert.deepEqual(report.added, { lines: ['e6 button "Retry"'], more: 0 });
  assert.deepEqual(report.removed, {
    lines: ['e4 button "Create account" disabled'],
    more: 0,
  });
  assert.deepEqual(report.updated, {
    lines: [
      'e2 textbox "Email" value="grace@example.com"',
      'e3 checkbox "Accept terms" unchecked',
    ],
    more: 0,
  });
  // The new button is a control, listed in added; only the paragraph is text.
  assert.deepEqual(report.text, { items: ["Card declined"], more: 0 });

  // The report ends tracking; the same document without it is lost.
  const again = runAction(context, { action: "change_status", ...ids });
  assert.deepEqual(again, { document: "same", lost: true });
  const lost = runAction(context, { action: "change_report", ...ids });
  assert.equal(lost.lost, true);
});

test("change_report skips screen-reader-only text and reports url and title changes", () => {
  const { context } = snapshotFixture();
  const mutate = installFakeMutationObserver(context);
  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c2",
  });

  const live = new FakeHTMLElement({
    tagName: "div",
    textContent: "Menu available",
    rect: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      top: 0,
      left: 0,
      right: 1,
      bottom: 1,
    },
  });
  live.nodeType = 1;
  mutate([{ type: "childList", addedNodes: [live] }]);
  context.location.href = "https://example.com/profile#saved";
  context.document.title = "Saved";

  const report = runAction(context, {
    action: "change_report",
    changeId: "c2",
    documentId,
  });
  assert.equal(report.urlChanged, true);
  assert.equal(report.titleChanged, true);
  assert.deepEqual(report.text, { items: [], more: 0 });
  assert.deepEqual(report.added.lines, []);
});

test("change_report lists a message revealed by an attribute change alone", () => {
  const { context } = snapshotFixture();
  installFakeMutationObserver(context);
  const message = new FakeHTMLElement({
    tagName: "p",
    attrs: { role: "alert" },
    textContent: "Invalid email",
  });
  // The browser computes display: none for [hidden]; the fake needs telling.
  message._style.display = "none";
  const querySelectorAll = context.document.querySelectorAll;
  context.document.querySelectorAll = (selector) =>
    selector.includes('[role="alert"]')
      ? [message]
      : querySelectorAll.call(context.document, selector);
  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c5",
  });

  message._style.display = "block";
  const report = runAction(context, {
    action: "change_report",
    changeId: "c5",
    documentId,
  });
  assert.deepEqual(report.text, { items: ["Invalid email"], more: 0 });
});

test("overlapping actions keep separate baselines", () => {
  const { context, email } = snapshotFixture();
  installFakeMutationObserver(context);
  const first = runAction(context, {
    action: "change_baseline",
    changeId: "a",
    owner: "server-1",
    active: ["a"],
  });
  email.value = "grace@example.com";
  const second = runAction(context, {
    action: "change_baseline",
    changeId: "b",
    owner: "server-1",
    active: ["a", "b"],
  });
  assert.equal(first.documentId, second.documentId);

  const a = runAction(context, {
    action: "change_report",
    changeId: "a",
    documentId: first.documentId,
  });
  const b = runAction(context, {
    action: "change_report",
    changeId: "b",
    documentId: second.documentId,
  });
  assert.equal(a.newDocument, false);
  assert.deepEqual(a.updated.lines, [
    'e2 textbox "Email" value="grace@example.com"',
  ]);
  assert.deepEqual(b.updated.lines, []);
});

test("a baseline drops the states its server no longer tracks", () => {
  const { context } = snapshotFixture();
  installFakeMutationObserver(context);
  const first = runAction(context, {
    action: "change_baseline",
    changeId: "old",
    owner: "server-1",
    active: ["old"],
  });
  runAction(context, {
    action: "change_baseline",
    changeId: "other",
    owner: "server-2",
    active: ["other"],
  });
  runAction(context, {
    action: "change_baseline",
    changeId: "new",
    owner: "server-1",
    active: ["new"],
  });

  const status = (changeId) =>
    runAction(context, {
      action: "change_status",
      changeId,
      documentId: first.documentId,
    });
  assert.equal(status("old").lost, true);
  assert.equal(status("other").document, "same");
  assert.equal(status("other").lost, undefined);
  assert.equal(status("new").lost, undefined);
});

test("change_report lists an element revealed by removing hidden", () => {
  const { context } = snapshotFixture();
  const mutate = installFakeMutationObserver(context);
  const panel = new FakeHTMLElement({
    tagName: "p",
    textContent: "Check your email",
  });
  panel._style.display = "none";
  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c8",
  });

  panel._style.display = "block";
  // Many text updates first must not crowd out the reveal.
  const counter = new FakeHTMLElement({ tagName: "span", textContent: "1" });
  const tick = { type: "characterData", target: { parentElement: counter } };
  mutate([
    ...Array.from({ length: 300 }, () => tick),
    { type: "attributes", attributeName: "hidden", target: panel },
    { type: "attributes", attributeName: "class", target: panel },
  ]);
  const report = runAction(context, {
    action: "change_report",
    changeId: "c8",
    documentId,
  });
  assert.deepEqual(report.text, {
    items: ["1", "Check your email"],
    more: 0,
  });
});

test("change_stop ends tracking without a report", () => {
  const { context } = snapshotFixture();
  installFakeMutationObserver(context);
  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c6",
  });
  const ids = { changeId: "c6", documentId };
  assert.deepEqual(runAction(context, { action: "change_stop", ...ids }), {
    stopped: true,
  });
  assert.equal(
    runAction(context, { action: "change_status", ...ids }).lost,
    true,
  );
});

test("change_report does not mistake controls crossing the control limit for changes", () => {
  const buttons = Array.from(
    { length: 501 },
    (_, index) =>
      new FakeHTMLElement({ tagName: "button", textContent: `Item ${index}` }),
  );
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: buttons });
  installFakeMutationObserver(context);
  const descendants = context.document.querySelectorAll("body *");
  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c7",
  });

  const first = new FakeHTMLElement({ tagName: "button", textContent: "New" });
  descendants.unshift(first);
  const report = runAction(context, {
    action: "change_report",
    changeId: "c7",
    documentId,
  });
  assert.deepEqual(report.added.lines, ['e501 button "New"']);
  assert.deepEqual(report.removed.lines, []);
});

test("change_report returns a snapshot of the new document after a navigation", () => {
  const { context } = snapshotFixture();
  installFakeMutationObserver(context);
  const { documentId } = runAction(context, {
    action: "change_baseline",
    changeId: "c3",
  });
  const ids = { changeId: "c3", documentId };

  // A navigation brings a new window without the old document's id.
  context.window = { innerWidth: 1280, innerHeight: 720 };
  const status = runAction(context, { action: "change_status", ...ids });
  assert.equal(status.document, "new");
  assert.equal(status.readyState, "complete");
  assert.equal(typeof status.quietMs, "number");

  const report = runAction(context, {
    action: "change_report",
    ...ids,
    limit: 2,
    refStart: 40,
  });
  assert.equal(report.newDocument, true);
  assert.deepEqual(report.nodes, [
    'e40 h1 "Sign up"',
    'e41 textbox "Email" value="ada@example.com"',
  ]);
  assert.equal(report.more, 3);
});

test("snapshot shows whether a password field is filled, never its value", () => {
  const password = new FakeHTMLInputElement({
    type: "password",
    attrs: { type: "password", "aria-label": "Password" },
    value: "hunter2",
  });
  const empty = new FakeHTMLInputElement({
    type: "password",
    attrs: { type: "password", "aria-label": "Confirm" },
  });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [password, empty] });

  const result = runAction(context, { action: "snapshot" });
  assert.deepEqual(result.nodes, [
    'e1 textbox "Password" filled',
    'e2 textbox "Confirm"',
  ]);
});

test("point_target reports the element at viewport coordinates, with a ref", () => {
  const canvas = new FakeHTMLElement({
    tagName: "canvas",
    attrs: { id: "map" },
  });
  const save = new FakeHTMLElement({ tagName: "button", textContent: "Save" });
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({
    body,
    descendants: [canvas],
    hit: canvas,
  });

  const result = runAction(context, { action: "point_target", x: 100, y: 50 });
  assert.equal(result.found, true);
  assert.deepEqual(result.point, { x: 100, y: 50 });
  assert.deepEqual(result.target, {
    ref: "e1",
    tagName: "CANVAS",
    id: "map",
    className: null,
  });

  const button = createPageContext({ body, descendants: [save], hit: save });
  assert.deepEqual(
    runAction(button, { action: "point_target", x: 1, y: 1 }).target,
    {
      ref: "e1",
      tagName: "BUTTON",
      id: null,
      className: null,
      role: "button",
      name: "Save",
    },
  );

  const outside = runAction(context, { action: "point_target", x: 1280, y: 5 });
  assert.equal(outside.found, false);
  assert.match(outside.error, /outside the viewport \(1280x720\)/);
});

test("html5_drag dispatches a drag with one DataTransfer and reports the drop", () => {
  const item = new FakeHTMLElement({ attrs: { draggable: "true" } });
  const zone = new FakeHTMLElement({ attrs: { id: "zone" } });
  const plain = new FakeHTMLElement({});
  item.closest = () => item;
  plain.closest = () => null;
  const fired = [];
  let takesDrop = true;
  const record = (element, name) => (event) => {
    fired.push([name, event.type]);
    if (event.type === "dragstart") {
      event.dataTransfer.setData("text/plain", "item-1");
    }
    if (event.type === "dragover" || (event.type === "drop" && takesDrop)) {
      event.defaultPrevented = true;
    }
    if (event.type === "drop") {
      fired.push(["data", event.dataTransfer.getData("text/plain")]);
    }
    if (event.type === "dragend") {
      fired.push(["dropEffect", event.dataTransfer.dropEffect]);
    }
    return !event.defaultPrevented;
  };
  item.dispatchEvent = record(item, "item");
  zone.dispatchEvent = record(zone, "zone");
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [item, zone] });
  context.document.elementFromPoint = (x) =>
    x < 100 ? item : x < 200 ? zone : plain;
  context.DataTransfer = class {
    constructor() {
      this.store = new Map();
      this.dropEffect = "none";
      this.effectAllowed = "none";
    }
    setData(type, value) {
      this.store.set(type, value);
    }
    getData(type) {
      return this.store.get(type) ?? "";
    }
  };
  context.DragEvent = class {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
      this.defaultPrevented = false;
    }
  };

  const from = { x: 50, y: 10 };
  assert.deepEqual(
    runAction(context, { action: "html5_drag", from, to: from, check: true }),
    { html5: true },
  );
  assert.deepEqual(
    runAction(context, {
      action: "html5_drag",
      from: { x: 250, y: 10 },
      to: from,
      check: true,
    }),
    { html5: false },
  );

  const result = runAction(context, {
    action: "html5_drag",
    from,
    to: { x: 150, y: 10 },
  });
  assert.deepEqual(result, { html5: true, dropped: true });
  assert.deepEqual(fired, [
    ["item", "dragstart"],
    ["item", "drag"],
    ["zone", "dragenter"],
    ["zone", "dragover"],
    ["zone", "drop"],
    ["data", "item-1"],
    ["item", "dragend"],
    ["dropEffect", "copy"],
  ]);

  // A target that picks an operation the source does not allow.
  item.dispatchEvent = (event) => {
    fired.push(["item", event.type]);
    if (event.type === "dragstart") {
      event.dataTransfer.effectAllowed = "copy";
    }
    if (event.type === "dragend") {
      fired.push(["dropEffect", event.dataTransfer.dropEffect]);
    }
    return true;
  };
  zone.dispatchEvent = (event) => {
    if (event.type === "dragover") {
      event.dataTransfer.dropEffect = "move";
      return false;
    }
    fired.push(["zone", event.type]);
    return event.type !== "drop";
  };
  fired.length = 0;
  assert.deepEqual(
    runAction(context, { action: "html5_drag", from, to: { x: 150, y: 10 } }),
    { html5: true, dropped: false },
  );
  assert.equal(
    fired.some(([, type]) => type === "drop"),
    false,
  );
  assert.deepEqual(fired.at(-1), ["dropEffect", "none"]);
  item.dispatchEvent = record(item, "item");
  zone.dispatchEvent = record(zone, "zone");

  // A target that allows the drop over it but does not take it.
  takesDrop = false;
  fired.length = 0;
  assert.deepEqual(
    runAction(context, { action: "html5_drag", from, to: { x: 150, y: 10 } }),
    { html5: true, dropped: false },
  );
  assert.deepEqual(fired.at(-1), ["dropEffect", "none"]);
});

test("html5_drag gives a link its URL and finds the drop target after dragstart", () => {
  const link = new FakeHTMLElement({ tagName: "a", attrs: { href: "/doc" } });
  link.href = "https://example.com/doc";
  link.closest = () => link;
  const overlay = new FakeHTMLElement({ attrs: { id: "overlay" } });
  const seen = [];
  link.dispatchEvent = (event) => {
    if (event.type === "dragstart") {
      // The page shows a drop overlay once a drag starts.
      started = true;
    }
    return true;
  };
  overlay.dispatchEvent = (event) => {
    seen.push([
      event.type,
      event.dataTransfer.getData("text/uri-list"),
      event.dataTransfer.dropEffect,
    ]);
    if (event.type === "dragover" || event.type === "drop") {
      event.defaultPrevented = true;
    }
    return !event.defaultPrevented;
  };
  let started = false;
  const body = new FakeHTMLElement({ tagName: "body" });
  const context = createPageContext({ body, descendants: [link, overlay] });
  context.document.elementFromPoint = (x) =>
    x < 100 ? link : started ? overlay : body;
  context.DataTransfer = class {
    constructor() {
      this.store = new Map();
      this.dropEffect = "none";
      this.effectAllowed = "none";
    }
    setData(type, value) {
      this.store.set(type, value);
    }
    getData(type) {
      return this.store.get(type) ?? "";
    }
  };
  context.DragEvent = class {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
      this.defaultPrevented = false;
    }
  };

  const result = runAction(context, {
    action: "html5_drag",
    from: { x: 10, y: 10 },
    to: { x: 300, y: 10 },
  });
  assert.deepEqual(result, { html5: true, dropped: true });
  assert.deepEqual(seen, [
    ["dragenter", "https://example.com/doc", "link"],
    ["dragover", "https://example.com/doc", "link"],
    ["drop", "https://example.com/doc", "link"],
  ]);
});
