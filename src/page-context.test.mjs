import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { buildPageContextExpression } from "./page-context.mjs";

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

class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLTextAreaElement extends FakeHTMLElement {}
class FakeHTMLSelectElement extends FakeHTMLElement {}

function createPageContext({ body, descendants = [], selectorMap = {} }) {
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

test("click results stay serializable and still invoke the element click handler", () => {
  const button = new FakeHTMLElement({
    tagName: "button",
    attrs: { class: "cta" },
    textContent: "View plan",
    innerText: "View plan",
    outerHTML: '<button class="cta">View plan</button>',
  });
  button.tabIndex = 0;

  const body = new FakeHTMLElement({
    tagName: "body",
    childElementCount: 1,
    outerHTML: "<body></body>",
  });

  const context = createPageContext({
    body,
    descendants: [button],
    selectorMap: {
      "button.cta": button,
    },
  });

  const expression = buildPageContextExpression(
    {
      browserFamily: "chromium",
      action: "click",
      selector: "button.cta",
    },
    { serialize: true },
  );

  const result = JSON.parse(vm.runInContext(expression, context));

  assert.equal(result.found, true);
  assert.equal(result.clicked, true);
  assert.equal(button.clickCount, 1);
  assert.deepEqual(result.node.locator, {
    locator: "button.cta",
    strategy: "css",
    query: "button.cta",
  });
  assert.equal("element" in result.node.locator, false);
});
