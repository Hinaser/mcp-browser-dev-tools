import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  assertPointerTarget,
  buildPageContextExpression,
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

      return [];
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
