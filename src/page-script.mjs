// Runs inside the page, not in Node: the broker serializes this function with
// toString() and evaluates it in the page context with a JSON payload. It must
// not reference anything outside itself except browser globals.
export function pageScript(payload) {
  const TEXT_LIMIT = 400;
  const VALUE_ONLY_INPUT_TYPES = [
    "date",
    "time",
    "datetime-local",
    "month",
    "week",
    "color",
    "range",
  ];

  function clipText(value, limit = TEXT_LIMIT) {
    if (typeof value !== "string") {
      return value ?? null;
    }

    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function getVisibleText(element) {
    if (!element) {
      return "";
    }

    if (typeof element.innerText === "string" && element.innerText.trim()) {
      return element.innerText;
    }

    return element.textContent ?? "";
  }

  // Compares the element's full visible text, with whitespace collapsed,
  // so text conditions are not limited by the clipped text in the node.
  function checkElementText(element, checks) {
    const text = normalizeText(
      typeof element.innerText === "string"
        ? element.innerText
        : element.textContent,
    );
    return checks.map(
      (check) =>
        (typeof check.textEquals !== "string" || text === check.textEquals) &&
        (typeof check.textIncludes !== "string" ||
          text.includes(check.textIncludes)) &&
        (typeof check.textExcludes !== "string" ||
          !text.includes(check.textExcludes)),
    );
  }

  function getLabelTextForControl(element) {
    if (!element || !element.id) {
      return "";
    }

    const label = document.querySelector(
      `label[for="${CSS.escape(element.id)}"]`,
    );
    return label ? normalizeText(getVisibleText(label)) : "";
  }

  // Text of a <label> wrapped around the control, leaving out the control
  // itself (a <select> would otherwise add every option's text).
  function getImplicitLabelText(element) {
    if (
      typeof element.closest !== "function" ||
      !["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)
    ) {
      return "";
    }

    const label = element.closest("label");
    if (!label) {
      return "";
    }

    const parts = [];
    const collect = (node) => {
      if (node === element) {
        return;
      }
      if (node.nodeType === 3) {
        parts.push(node.textContent);
        return;
      }
      if (
        node.nodeType !== 1 ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName)
      ) {
        return;
      }
      if (typeof node.contains === "function" && node.contains(element)) {
        for (const child of node.childNodes ?? []) {
          collect(child);
        }
        return;
      }
      parts.push(getVisibleText(node));
    };
    for (const node of label.childNodes ?? []) {
      collect(node);
    }
    return normalizeText(parts.join(""));
  }

  function isPassword(element) {
    return (
      element.tagName === "INPUT" &&
      (element.getAttribute("type") || "").toLowerCase() === "password"
    );
  }

  function getAccessibleName(element) {
    if (!element) {
      return "";
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return normalizeText(ariaLabel);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => normalizeText(getVisibleText(node)))
        .filter(Boolean)
        .join(" ");
      if (text) {
        return text;
      }
    }

    const labelText =
      getLabelTextForControl(element) || getImplicitLabelText(element);
    if (labelText) {
      return labelText;
    }

    const alt = element.getAttribute("alt");
    if (alt) {
      return normalizeText(alt);
    }

    const title = element.getAttribute("title");
    if (title) {
      return normalizeText(title);
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return isPassword(element) ? "" : normalizeText(element.value);
    }

    return normalizeText(getVisibleText(element));
  }

  function inferRole(element) {
    if (!element) {
      return null;
    }

    const explicitRole = element.getAttribute("role");
    if (explicitRole) {
      return explicitRole;
    }

    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "dialog") return "dialog";
    if (tag === "img") return "img";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset")
        return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }

    return null;
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      element.hidden ||
      element.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.pointerEvents === "none"
    ) {
      return false;
    }

    return rect.width > 0 && rect.height > 0;
  }

  // :disabled covers controls inside a disabled <fieldset>, whose own
  // disabled property stays false.
  function isDisabled(element) {
    return Boolean(
      element &&
      (element.disabled === true ||
        element.getAttribute("aria-disabled") === "true" ||
        (typeof element.matches === "function" &&
          element.matches(":disabled"))),
    );
  }

  function isEditable(element) {
    return Boolean(
      element &&
      (element.isContentEditable ||
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement &&
          !["button", "submit", "reset", "checkbox", "radio", "file"].includes(
            (element.type || "text").toLowerCase(),
          ))),
    );
  }

  function isFocusable(element) {
    if (!element || isDisabled(element)) {
      return false;
    }

    if (typeof element.tabIndex === "number" && element.tabIndex >= 0) {
      return true;
    }

    const tag = element.tagName.toLowerCase();
    return ["a", "button", "input", "select", "textarea"].includes(tag);
  }

  function isClickable(element) {
    if (!element || isDisabled(element)) {
      return false;
    }

    const role = inferRole(element);
    const tag = element.tagName.toLowerCase();
    return (
      ["button", "link", "checkbox", "radio", "option"].includes(role) ||
      ["button", "a", "summary", "option"].includes(tag) ||
      typeof element.onclick === "function"
    );
  }

  function isScrollable(element) {
    if (!element) {
      return false;
    }

    return (
      element.scrollHeight > element.clientHeight ||
      element.scrollWidth > element.clientWidth
    );
  }

  function toAttributeObject(element) {
    return Object.fromEntries(
      Array.from(element.attributes, (attribute) => [
        attribute.name,
        attribute.value,
      ]),
    );
  }

  function summarizeLocator(locator) {
    if (!locator || typeof locator !== "object") {
      return null;
    }

    const summary = {};
    for (const key of [
      "locator",
      "strategy",
      "query",
      "role",
      "name",
      "error",
    ]) {
      if (locator[key] !== undefined) {
        summary[key] = locator[key];
      }
    }

    return summary;
  }

  function describeElement(element, locator) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const role = inferRole(element);
    const accessibleName = getAccessibleName(element);

    return {
      locator: summarizeLocator(locator),
      tagName: element.tagName,
      id: element.getAttribute("id"),
      className: element.getAttribute("class"),
      childElementCount: element.childElementCount,
      attributes: toAttributeObject(element),
      textContent: clipText(element.textContent ?? null),
      innerText: clipText(
        typeof element.innerText === "string" ? element.innerText : null,
      ),
      value:
        "value" in element && typeof element.value === "string"
          ? clipText(element.value)
          : null,
      accessibleName: accessibleName || null,
      role,
      visible: isVisible(element),
      disabled: isDisabled(element),
      focused: document.activeElement === element,
      editable: isEditable(element),
      focusable: isFocusable(element),
      clickable: isClickable(element),
      scrollable: isScrollable(element),
      checked: "checked" in element ? Boolean(element.checked) : null,
      selected: "selected" in element ? Boolean(element.selected) : null,
      open: "open" in element ? Boolean(element.open) : null,
      box: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      styles: {
        display: style.display,
        visibility: style.visibility,
        position: style.position,
        zIndex: style.zIndex,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
      },
      outerHTML: clipText(element.outerHTML, 1200),
    };
  }

  function parseRoleLocator(value) {
    const match = value.match(
      /^([^[]+?)(?:\[name=(?:"([^"]*)"|'([^']*)')\])?$/,
    );
    if (!match) {
      return {
        role: normalizeText(value) || null,
        name: null,
      };
    }

    return {
      role: normalizeText(match[1]) || null,
      name: normalizeText(match[2] ?? match[3] ?? "") || null,
    };
  }

  function collectCandidates() {
    return Array.from(document.querySelectorAll("body *"));
  }

  const SNAPSHOT_LIMIT = 40;
  const SNAPSHOT_TEXT_LIMIT = 80;
  const CONTROL_ROLES = [
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "textbox",
    "searchbox",
    "combobox",
    "spinbutton",
    "slider",
    "tab",
    "menuitem",
    "option",
  ];

  function resolvesTo(locator, element) {
    try {
      return resolveLocator(locator).element === element;
    } catch {
      return false;
    }
  }

  // Suggests a locator the tools accept that resolves back to this element:
  // its id, its form field name (and value), or its role and accessible
  // name. Returns null when none of them does.
  function suggestLocator(element, role, name) {
    const id = element.getAttribute("id");
    if (
      id &&
      /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) &&
      resolvesTo("#" + id, element)
    ) {
      return "#" + id;
    }

    const tag = element.tagName.toLowerCase();
    const fieldName = element.getAttribute("name");
    if (fieldName && ["input", "select", "textarea"].includes(tag)) {
      const selector = tag + '[name="' + CSS.escape(fieldName) + '"]';
      if (resolvesTo(selector, element)) {
        return selector;
      }
      const value = element.getAttribute("value");
      if (value && !isPassword(element)) {
        const withValue = selector + '[value="' + CSS.escape(value) + '"]';
        if (resolvesTo(withValue, element)) {
          return withValue;
        }
      }
    }

    if (role && name && !name.includes('"')) {
      const byRole = "role=" + role + '[name="' + name + '"]';
      if (resolvesTo(byRole, element)) {
        return byRole;
      }
    }
    return null;
  }

  function describeControl(element, role) {
    const name = normalizeText(getAccessibleName(element));
    const control = {
      locator: suggestLocator(element, role, name),
      role,
    };
    if (name) {
      control.name = clipText(name, SNAPSHOT_TEXT_LIMIT);
    }
    if (
      ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(
        role,
      ) &&
      "value" in element &&
      typeof element.value === "string" &&
      !isPassword(element)
    ) {
      control.value = clipText(element.value, SNAPSHOT_TEXT_LIMIT);
      // The accessible name of a field can fall back to its value.
      if (name && name === normalizeText(element.value)) {
        delete control.name;
      }
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      control.checked =
        "checked" in element
          ? Boolean(element.checked)
          : element.getAttribute("aria-checked") === "true";
    }
    if (isDisabled(element)) {
      control.disabled = true;
    }
    return control;
  }

  // Lists the visible controls on the page, so an agent can fix a failed
  // step without another round trip to look around.
  function snapshotControls() {
    const controls = [];
    let more = 0;
    for (const element of collectCandidates()) {
      const role = inferRole(element);
      const editable =
        element.hasAttribute("contenteditable") && element.isContentEditable;
      if (!(CONTROL_ROLES.includes(role) || editable) || !isVisible(element)) {
        continue;
      }
      if (controls.length >= SNAPSHOT_LIMIT) {
        more += 1;
        continue;
      }
      controls.push(describeControl(element, role ?? "textbox"));
    }
    return { controls, moreControls: more };
  }

  function describePage() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
      },
    };
  }

  function parseDocumentCookies() {
    const COOKIE_LIMIT = 100;
    const NAME_LIMIT = 120;
    const VALUE_LIMIT = 300;
    const cookieText =
      typeof document.cookie === "string" ? document.cookie.trim() : "";

    if (!cookieText) {
      return {
        totalEntries: 0,
        returnedEntries: 0,
        truncated: false,
        entries: [],
        source: "document.cookie",
      };
    }

    const rawEntries = cookieText
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const entries = rawEntries.slice(0, COOKIE_LIMIT).map((entry) => {
      const separatorIndex = entry.indexOf("=");
      const name =
        separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
      const value =
        separatorIndex === -1 ? "" : entry.slice(separatorIndex + 1);
      return {
        name: clipText(name, NAME_LIMIT),
        value: clipText(value, VALUE_LIMIT),
      };
    });

    return {
      totalEntries: rawEntries.length,
      returnedEntries: entries.length,
      truncated: rawEntries.length > COOKIE_LIMIT,
      entries,
      source: "document.cookie",
    };
  }

  function snapshotStorage(storage, type) {
    const STORAGE_LIMIT = 100;
    const KEY_LIMIT = 200;
    const VALUE_LIMIT = 300;

    try {
      const totalEntries = storage.length;
      const entries = [];
      const limit = Math.min(totalEntries, STORAGE_LIMIT);

      for (let index = 0; index < limit; index += 1) {
        const key = storage.key(index);
        if (key === null) {
          continue;
        }

        entries.push({
          key: clipText(key, KEY_LIMIT),
          value: clipText(storage.getItem(key), VALUE_LIMIT),
        });
      }

      return {
        type,
        totalEntries,
        returnedEntries: entries.length,
        truncated: totalEntries > STORAGE_LIMIT,
        entries,
      };
    } catch (error) {
      return {
        type,
        totalEntries: 0,
        returnedEntries: 0,
        truncated: false,
        entries: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function summarizeStorage(storage, type) {
    const SAMPLE_LIMIT = 20;
    const KEY_LIMIT = 80;

    try {
      const totalEntries = storage.length;
      const sampleKeys = [];
      const limit = Math.min(totalEntries, SAMPLE_LIMIT);

      for (let index = 0; index < limit; index += 1) {
        const key = storage.key(index);
        if (key !== null) {
          sampleKeys.push(clipText(key, KEY_LIMIT));
        }
      }

      return {
        type,
        totalEntries,
        sampleKeys,
        truncated: totalEntries > SAMPLE_LIMIT,
      };
    } catch (error) {
      return {
        type,
        totalEntries: 0,
        sampleKeys: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function resolveLocator(rawLocator) {
    const locator = typeof rawLocator === "string" ? rawLocator.trim() : "";
    if (!locator) {
      throw new Error("selector must be a non-empty string");
    }

    if (locator.startsWith("text=")) {
      const query = normalizeText(locator.slice(5));
      const candidates = collectCandidates();
      const match =
        candidates.find(
          (element) =>
            isVisible(element) &&
            normalizeText(getVisibleText(element)) === query,
        ) ??
        candidates.find((element) => {
          const text = normalizeText(getVisibleText(element));
          return isVisible(element) && text && text.includes(query);
        });

      return {
        locator,
        strategy: "text",
        query,
        element: match ?? null,
      };
    }

    if (locator.startsWith("role=")) {
      const { role, name } = parseRoleLocator(locator.slice(5).trim());
      const candidates = collectCandidates();
      const match = candidates.find((element) => {
        const elementRole = normalizeText(inferRole(element) ?? "");
        const accessibleName = normalizeText(getAccessibleName(element));
        if (!elementRole || elementRole !== role) {
          return false;
        }

        if (!name) {
          return true;
        }

        return accessibleName === name || accessibleName.includes(name);
      });

      return {
        locator,
        strategy: "role",
        role,
        name,
        element: match ?? null,
      };
    }

    if (locator.startsWith("name=")) {
      const query = normalizeText(locator.slice(5));
      const candidates = collectCandidates();
      const found =
        candidates.find((element) => {
          const accessibleName = normalizeText(getAccessibleName(element));
          return isVisible(element) && accessibleName === query;
        }) ??
        candidates.find((element) => {
          const accessibleName = normalizeText(getAccessibleName(element));
          return (
            isVisible(element) &&
            accessibleName &&
            accessibleName.includes(query)
          );
        });

      // A label's text names its control, so act on the control when it is
      // visible; a styled checkbox hides its input and leaves the label.
      const match =
        found?.tagName === "LABEL" && found.control && isVisible(found.control)
          ? found.control
          : found;

      return {
        locator,
        strategy: "name",
        query,
        element: match ?? null,
      };
    }

    const cssSelector = locator.startsWith("css=") ? locator.slice(4) : locator;
    try {
      return {
        locator,
        strategy: "css",
        query: cssSelector,
        element: document.querySelector(cssSelector),
      };
    } catch (error) {
      return {
        locator,
        strategy: "css",
        query: cssSelector,
        element: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function ensureResolved(rawLocator) {
    const resolved = resolveLocator(rawLocator);
    if (resolved.error) {
      return {
        browserFamily: payload.browserFamily,
        selector: rawLocator,
        found: false,
        locator: summarizeLocator(resolved),
        error: resolved.error,
      };
    }

    if (!resolved.element) {
      return {
        browserFamily: payload.browserFamily,
        selector: rawLocator,
        found: false,
        locator: summarizeLocator(resolved),
      };
    }

    return resolved;
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(
      new Event("input", { bubbles: true, composed: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true, composed: true }),
    );
  }

  // Assigning element.value directly also updates the value tracker React
  // keeps on the instance, so React would treat the next input event as a
  // no-op. The prototype setter bypasses that tracker.
  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")
      : null;
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function maybeScrollIntoView(element) {
    if (!element || payload.scrollIntoView === false) {
      return;
    }

    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
  }

  function summarizeTarget(element) {
    return element
      ? {
          tagName: element.tagName,
          id: element.getAttribute("id"),
          className: element.getAttribute("class"),
        }
      : null;
  }

  function getDeepActiveElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function focusElement(element) {
    if (typeof element.focus === "function") {
      element.focus();
    }

    const active = getDeepActiveElement();
    return Boolean(
      active &&
      (active === element ||
        (element.isContentEditable &&
          typeof active.contains === "function" &&
          active.contains(element))),
    );
  }

  function findClickablePoint(element) {
    const rects =
      typeof element.getClientRects === "function"
        ? Array.from(element.getClientRects())
        : [];
    if (rects.length === 0) {
      rects.push(element.getBoundingClientRect());
    }

    for (const rect of rects) {
      const left = Math.max(rect.left, 0);
      const top = Math.max(rect.top, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      if (right - left >= 1 && bottom - top >= 1) {
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      }
    }

    return null;
  }

  function hitTest(point) {
    let hit = document.elementFromPoint(point.x, point.y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (!inner || inner === hit) {
        break;
      }
      hit = inner;
    }
    return hit;
  }

  function receivesPointerAt(element, hit) {
    for (let node = hit; node; node = node.parentNode ?? node.host ?? null) {
      if (node === element) {
        return true;
      }
    }

    // Styled checkboxes often hide the input behind its <label>, which
    // forwards the click to the control.
    const label =
      typeof hit?.closest === "function" ? hit.closest("label") : null;
    return Boolean(label && label.control === element);
  }

  function runAction() {
    switch (payload.action) {
      case "controls_snapshot":
        return {
          browserFamily: payload.browserFamily,
          url: location.href,
          title: document.title,
          ...snapshotControls(),
        };
      case "page_state":
        return {
          browserFamily: payload.browserFamily,
          page: describePage(),
        };
      case "inspect": {
        const resolved = ensureResolved(payload.selector);
        if (!resolved.element) {
          return resolved;
        }

        maybeScrollIntoView(resolved.element);

        return {
          browserFamily: payload.browserFamily,
          selector: payload.selector,
          found: true,
          node: describeElement(resolved.element, resolved),
          ...(Array.isArray(payload.textChecks)
            ? {
                textMatches: checkElementText(
                  resolved.element,
                  payload.textChecks,
                ),
              }
            : {}),
        };
      }
      case "pointer_target": {
        const resolved = ensureResolved(payload.selector);
        if (!resolved.element) {
          return resolved;
        }

        maybeScrollIntoView(resolved.element);
        const point = findClickablePoint(resolved.element);
        const hit = point ? hitTest(point) : null;
        const receivesEvents = Boolean(
          hit && receivesPointerAt(resolved.element, hit),
        );

        return {
          browserFamily: payload.browserFamily,
          selector: payload.selector,
          found: true,
          point,
          receivesEvents,
          obscuredBy: receivesEvents ? null : summarizeTarget(hit),
          node: describeElement(resolved.element, resolved),
        };
      }
      case "prepare_type": {
        const resolved = ensureResolved(payload.selector);
        if (!resolved.element) {
          return resolved;
        }

        const element = resolved.element;
        const clear = payload.clear !== false;
        maybeScrollIntoView(element);

        const isTextControl =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement;
        if (!isEditable(element) || isDisabled(element)) {
          throw new Error("Resolved element is not editable");
        }
        if (element.readOnly === true) {
          throw new Error("Resolved element is read-only");
        }

        // Pickers such as date or color inputs do not accept typed text, so
        // their value is set directly.
        if (
          element instanceof HTMLInputElement &&
          VALUE_ONLY_INPUT_TYPES.includes((element.type || "").toLowerCase())
        ) {
          focusElement(element);
          setNativeValue(element, payload.text);
          dispatchInputEvents(element);
          return {
            browserFamily: payload.browserFamily,
            selector: payload.selector,
            found: true,
            method: "value",
            typedText: payload.text,
            node: describeElement(element, resolved),
          };
        }

        if (!focusElement(element)) {
          throw new Error("Could not focus the resolved element");
        }

        if (isTextControl) {
          if (clear) {
            element.select();
          } else {
            const end = element.value.length;
            try {
              element.setSelectionRange(end, end);
            } catch {
              // email and number inputs do not support selection ranges.
            }
          }
        } else {
          const range = document.createRange();
          range.selectNodeContents(element);
          if (!clear) {
            range.collapse(false);
          }
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }

        return {
          browserFamily: payload.browserFamily,
          selector: payload.selector,
          found: true,
          method: "native",
          node: describeElement(element, resolved),
        };
      }
      case "select": {
        const resolved = ensureResolved(payload.selector);
        if (!resolved.element) {
          return resolved;
        }

        if (!(resolved.element instanceof HTMLSelectElement)) {
          throw new Error("Resolved element is not a <select>");
        }

        const option =
          Array.from(resolved.element.options).find(
            (candidate) =>
              (payload.value &&
                (candidate.value === payload.value ||
                  candidate.text === payload.value)) ||
              (payload.label &&
                normalizeText(candidate.text).includes(
                  normalizeText(payload.label),
                )),
          ) ?? null;

        if (!option) {
          throw new Error("No matching <option> found");
        }

        resolved.element.value = option.value;
        dispatchInputEvents(resolved.element);

        return {
          browserFamily: payload.browserFamily,
          selector: payload.selector,
          found: true,
          selectedValue: option.value,
          selectedLabel: option.text,
          node: describeElement(resolved.element, resolved),
        };
      }
      case "focus": {
        if (payload.selector) {
          const resolved = ensureResolved(payload.selector);
          if (!resolved.element) {
            return resolved;
          }

          maybeScrollIntoView(resolved.element);
          if (!focusElement(resolved.element)) {
            throw new Error("Could not focus the resolved element");
          }
        }

        return {
          browserFamily: payload.browserFamily,
          selector: payload.selector ?? null,
          found: true,
          target: summarizeTarget(getDeepActiveElement() ?? document.body),
        };
      }
      case "scroll": {
        if (payload.selector) {
          const resolved = ensureResolved(payload.selector);
          if (!resolved.element) {
            return resolved;
          }

          resolved.element.scrollIntoView({
            block: payload.block || "center",
            inline: "nearest",
          });

          return {
            browserFamily: payload.browserFamily,
            selector: payload.selector,
            found: true,
            scrolled: true,
            node: describeElement(resolved.element, resolved),
          };
        }

        window.scrollBy({
          left: Number.isFinite(payload.deltaX) ? payload.deltaX : 0,
          top: Number.isFinite(payload.deltaY) ? payload.deltaY : 0,
          behavior: "instant",
        });

        return {
          browserFamily: payload.browserFamily,
          scrolled: true,
          pageXOffset: window.pageXOffset,
          pageYOffset: window.pageYOffset,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        };
      }
      case "network_snapshot": {
        const entries = [
          ...performance.getEntriesByType("navigation"),
          ...performance.getEntriesByType("resource"),
        ].map((entry, index) => ({
          requestId: `snapshot-${index + 1}-${entry.name || "entry"}`,
          url: entry.name || location.href,
          method: entry.entryType === "navigation" ? "GET" : "GET",
          resourceType: entry.initiatorType || entry.entryType || null,
          startedAt: entry.startTime ?? 0,
          completedAt: (entry.startTime ?? 0) + (entry.duration ?? 0),
          duration: entry.duration ?? null,
          transferSize:
            typeof entry.transferSize === "number" ? entry.transferSize : null,
          encodedBodySize:
            typeof entry.encodedBodySize === "number"
              ? entry.encodedBodySize
              : null,
          decodedBodySize:
            typeof entry.decodedBodySize === "number"
              ? entry.decodedBodySize
              : null,
        }));

        return {
          browserFamily: payload.browserFamily,
          entries,
        };
      }
      case "cookie_snapshot":
        return {
          browserFamily: payload.browserFamily,
          cookies: parseDocumentCookies(),
        };
      case "storage_snapshot":
        return {
          browserFamily: payload.browserFamily,
          storage: {
            localStorage: snapshotStorage(localStorage, "localStorage"),
            sessionStorage: snapshotStorage(sessionStorage, "sessionStorage"),
          },
        };
      case "debug_report": {
        const cookies = parseDocumentCookies();
        return {
          browserFamily: payload.browserFamily,
          page: describePage(),
          cookies: {
            totalEntries: cookies.totalEntries,
            returnedEntries: cookies.returnedEntries,
            truncated: cookies.truncated,
            sampleNames: cookies.entries.map((entry) => entry.name),
          },
          storage: {
            localStorage: summarizeStorage(localStorage, "localStorage"),
            sessionStorage: summarizeStorage(sessionStorage, "sessionStorage"),
          },
        };
      }
      case "restore_snapshot": {
        const snapshot = payload.snapshot ?? {};
        const clearStorage = payload.clearStorage === true;
        const snapshotUrl = snapshot.page?.url ?? null;
        const snapshotOrigin = snapshotUrl ? new URL(snapshotUrl).origin : null;
        const currentOrigin = location.origin;

        if (snapshotOrigin && snapshotOrigin !== currentOrigin) {
          throw new Error(
            "Snapshot origin " +
              snapshotOrigin +
              " does not match current origin " +
              currentOrigin,
          );
        }

        const restoreEntries = (storage, entries) => {
          const safeEntries = Array.isArray(entries)
            ? entries.slice(0, 100)
            : [];
          if (clearStorage) {
            storage.clear();
          }

          for (const entry of safeEntries) {
            if (!entry || typeof entry.key !== "string") {
              continue;
            }

            storage.setItem(
              entry.key,
              typeof entry.value === "string" ? entry.value : "",
            );
          }

          return safeEntries.length;
        };

        const restoreCookies = (entries) => {
          const safeEntries = Array.isArray(entries)
            ? entries.slice(0, 100)
            : [];
          for (const entry of safeEntries) {
            if (!entry || typeof entry.name !== "string") {
              continue;
            }

            const encodedName = encodeURIComponent(entry.name);
            const encodedValue = encodeURIComponent(
              typeof entry.value === "string" ? entry.value : "",
            );
            document.cookie =
              encodedName + "=" + encodedValue + "; path=/; SameSite=Lax";
          }

          return safeEntries.length;
        };

        return {
          browserFamily: payload.browserFamily,
          restoredAt: new Date().toISOString(),
          clearStorage,
          snapshotOrigin: snapshotOrigin ?? currentOrigin,
          currentOrigin,
          restored: {
            cookies: restoreCookies(snapshot.cookies?.entries),
            localStorage: restoreEntries(
              localStorage,
              snapshot.storage?.localStorage?.entries,
            ),
            sessionStorage: restoreEntries(
              sessionStorage,
              snapshot.storage?.sessionStorage?.entries,
            ),
          },
          page: describePage(),
        };
      }
      default:
        throw new Error(`Unsupported page action: ${payload.action}`);
    }
  }

  return runAction();
}
