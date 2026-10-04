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
    if (/^h[1-6]$/.test(tag)) return "heading";
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
      // Not an ARIA role: it tells an agent to use upload_file, since a
      // click opens a native file dialog.
      if (type === "file") return "file";
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

  // Refs (e12) name elements across calls: get_snapshot hands them out and
  // ref= locators look them up. The registry lives on the window, so it
  // lasts until the page navigates, and an element keeps its ref between
  // snapshots. Numbering continues from payload.refStart, which the server
  // carries across navigations, so a ref from an earlier page never names
  // an element on a later one. Elements that left the document are dropped
  // at each snapshot, so the registry does not keep an SPA's old trees alive.
  const REF_REGISTRY_KEY = "__mcpBrowserDevToolsRefs";

  function refRegistry() {
    let registry = window[REF_REGISTRY_KEY];
    if (!registry) {
      registry = { next: 1, byRef: new Map(), byElement: new WeakMap() };
      Object.defineProperty(window, REF_REGISTRY_KEY, {
        value: registry,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    const start = Number(payload.refStart);
    if (start > registry.next) {
      registry.next = start;
    }
    return registry;
  }

  function pruneRefs(registry) {
    for (const [ref, element] of registry.byRef) {
      if (!element.isConnected) {
        registry.byRef.delete(ref);
        registry.byElement.delete(element);
      }
    }
  }

  function refFor(element) {
    const registry = refRegistry();
    let ref = registry.byElement.get(element);
    if (!ref) {
      ref = "e" + registry.next++;
      registry.byElement.set(element, ref);
      registry.byRef.set(ref, element);
    }
    return ref;
  }

  function resolveRef(query) {
    const registry = window[REF_REGISTRY_KEY];
    const element = registry?.byRef.get(query) ?? null;
    if (!element) {
      return {
        element: null,
        error:
          "Unknown ref " +
          query +
          ": refs come from get_snapshot on this page and a navigation invalidates them; call get_snapshot again",
      };
    }
    if (!element.isConnected) {
      return {
        element: null,
        error:
          "Stale ref " +
          query +
          ": its element left the document; call get_snapshot again",
      };
    }
    return { element };
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
    "file",
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

  // Finding a locator resolves candidates against the whole page, so the
  // line-based snapshots, which do not print it, skip it.
  function describeControl(element, role, options = {}) {
    const name = normalizeText(getAccessibleName(element));
    const control = { ref: refFor(element) };
    if (options.locators !== false) {
      control.locator = suggestLocator(element, role, name);
    }
    control.role = role;
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
    if (role === "file" && element.files) {
      control.value = clipText(
        Array.from(element.files, (file) => file.name).join(", "),
        SNAPSHOT_TEXT_LIMIT,
      );
    }
    // A password's value stays out, but whether it is filled is shown, so
    // typing one is visible in the snapshot and in an action's changes.
    if (isPassword(element) && typeof element.value === "string") {
      control.filled = element.value.length > 0;
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

  function describeHeading(element) {
    const tag = element.tagName.toLowerCase();
    const level = /^h[1-6]$/.test(tag)
      ? Number(tag.slice(1))
      : Number(element.getAttribute("aria-level")) || 2;
    return {
      ref: refFor(element),
      role: "heading",
      level,
      name: clipText(
        normalizeText(getAccessibleName(element)),
        SNAPSHOT_TEXT_LIMIT,
      ),
    };
  }

  // Lists the visible controls on the page (and its headings, when asked),
  // in document order, so an agent can decide what to do next, or fix a
  // failed step, without another round trip to look around.
  function snapshotControls(options = {}) {
    pruneRefs(refRegistry());
    const limit = options.limit ?? SNAPSHOT_LIMIT;
    const root = options.root ?? document;
    const candidates =
      root === document
        ? collectCandidates()
        : Array.from(root.querySelectorAll("*"));
    if (root !== document && root !== document.body) {
      candidates.unshift(root);
    }
    const controls = [];
    let more = 0;
    for (const element of candidates) {
      const role = inferRole(element);
      const editable =
        element.hasAttribute("contenteditable") && element.isContentEditable;
      const heading = options.headings && role === "heading";
      if (
        !(CONTROL_ROLES.includes(role) || editable || heading) ||
        !isVisible(element)
      ) {
        continue;
      }
      if (controls.length >= limit) {
        more += 1;
        options.beyond?.add(element);
        continue;
      }
      controls.push(
        heading
          ? describeHeading(element)
          : describeControl(element, role ?? "textbox", options),
      );
    }
    return { controls, moreControls: more, nextRef: refRegistry().next };
  }

  // One line per node, compact enough to send on every turn:
  //   e3 textbox "Email" value="ada@example.com"
  //   e4 checkbox "Accept terms" checked
  function formatSnapshotLine(node) {
    const parts = [
      node.ref,
      node.role === "heading" ? "h" + node.level : node.role,
    ];
    if (node.name) {
      parts.push(JSON.stringify(node.name));
    }
    if (node.value !== undefined) {
      parts.push("value=" + JSON.stringify(node.value));
    }
    if (node.filled) {
      parts.push("filled");
    }
    if (node.checked !== undefined) {
      parts.push(node.checked ? "checked" : "unchecked");
    }
    if (node.disabled) {
      parts.push("disabled");
    }
    return parts.join(" ");
  }

  function snapshotPage() {
    const result = {
      browserFamily: payload.browserFamily,
      url: location.href,
      title: document.title,
    };
    let root = document;
    if (payload.selector) {
      const resolved = ensureResolved(payload.selector);
      if (!resolved.element) {
        return { ...result, ...resolved };
      }
      root = resolved.element;
    }
    const { controls, moreControls, nextRef } = snapshotControls({
      root,
      limit: payload.limit,
      headings: payload.headings !== false,
      locators: false,
    });
    return {
      ...result,
      found: true,
      nodes: controls.map(formatSnapshotLine),
      more: moreControls,
      nextRef,
    };
  }

  // Actions report what they changed. change_baseline records the visible
  // headings and controls, and the text of live regions, before the action
  // and watches the DOM; change_status tells the server how long the DOM has
  // been quiet; change_report diffs against the baseline and lists the text
  // the action added or revealed. Each action keeps its own state, keyed by
  // its change id, so overlapping actions do not disturb each other; each
  // baseline drops the states its server no longer tracks.
  // A navigation brings a new window with a new document id; on it,
  // change_status watches the new document for quiet and change_report
  // returns its snapshot.
  const CHANGE_KEY = "__mcpBrowserDevToolsChanges";
  const DOCUMENT_KEY = "__mcpBrowserDevToolsDocument";
  const CHANGE_CONTROL_LIMIT = 500;
  const CHANGE_LINE_LIMIT = 15;
  const CHANGE_TEXT_LIMIT = 5;
  const CHANGE_TEXT_CHARS = 160;
  const CHANGE_WATCH_LIMIT = 200;
  const CHANGE_MESSAGE_LIMIT = 200;
  // States of another server (another MCP client on the tab) are dropped
  // when this old, in case that server went away mid-action.
  const CHANGE_STALE_MS = 3_600_000;
  const MESSAGE_SELECTOR =
    '[role="alert"], [role="status"], [role="alertdialog"], [aria-live], output';
  // Attributes whose change can reveal an element without adding nodes.
  const REVEAL_ATTRIBUTES = ["hidden", "aria-hidden", "open"];

  function defineHidden(key, value) {
    Object.defineProperty(window, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    return value;
  }

  function documentId() {
    return (
      window[DOCUMENT_KEY] ??
      defineHidden(
        DOCUMENT_KEY,
        Math.random().toString(36).slice(2) + Date.now().toString(36),
      )
    );
  }

  function changeStates() {
    return window[CHANGE_KEY] ?? defineHidden(CHANGE_KEY, new Map());
  }

  // Keeps the distinct elements that gained nodes or text, and apart from
  // them those whose hiding attribute changed, to read their text later.
  // Each set is capped, so a page that rebuilds itself stays cheap.
  function remember(set, element) {
    if (element && set.size < CHANGE_WATCH_LIMIT) {
      set.add(element);
    }
  }

  function recordMutations(state, records) {
    state.lastMutationAt = Date.now();
    for (const record of records) {
      if (record.type === "attributes") {
        if (REVEAL_ATTRIBUTES.includes(record.attributeName)) {
          remember(state.revealed, record.target);
        }
      } else if (record.type === "characterData") {
        remember(state.touched, record.target.parentElement);
      } else if (record.type === "childList") {
        for (const node of record.addedNodes) {
          remember(
            state.touched,
            node.nodeType === 1 ? node : node.parentElement,
          );
        }
      }
    }
  }

  // Changes often come a moment after the action, from a timer: a redirect
  // 300 ms after "Signed in", a search debounced until typing pauses. While
  // an action is tracked, setTimeout is wrapped to count the timers set with
  // delays from TIMER_MIN_MS to TIMER_MAX_MS, so the server waits for them
  // as it does for requests. Loops (polling, animation) would keep a page
  // from settling, so a timer is not counted when it is set from inside
  // another timer's callback, or when its handler already ran while the
  // action was tracked. The wrappers are put over whatever the page has at
  // the time and put back when no action is tracked, unless the page has
  // since wrapped them in turn; they then stay, passing calls through.
  const TIMER_KEY = "__mcpBrowserDevToolsTimers";
  const TIMER_MIN_MS = 50;
  const TIMER_MAX_MS = 1000;

  // A delay as the browser would read it, without calling a page object's
  // valueOf, which could differ between calls.
  function timerDelay(delay) {
    if (delay === undefined) {
      return 0;
    }
    if (typeof delay === "number" || typeof delay === "string") {
      return Number(delay);
    }
    return Number.NaN;
  }

  function timerWatch() {
    return (
      window[TIMER_KEY] ??
      defineHidden(TIMER_KEY, {
        timers: new Map(),
        ran: new WeakSet(),
        callbacks: new WeakSet(),
        users: 0,
        inTimer: false,
        installed: {},
      })
    );
  }

  // Fresh wrappers for each period of tracking, each calling the function
  // it was put over. One a page saved earlier may still be in its chain;
  // a new one cannot be, so calls never loop back into it.
  function timerWrappers(watch, natives) {
    const call = (name, args) => natives[name].apply(window, args);
    const wrappers = {
      setTimeout(handler, delay, ...args) {
        // A callback of ours, passed on by a newer wrapper through a page's
        // chain, was counted (or not) there already.
        if (typeof handler !== "function" || watch.callbacks.has(handler)) {
          return call("setTimeout", [handler, delay, ...args]);
        }
        const ms = timerDelay(delay);
        const counted =
          watch.users > 0 &&
          !watch.inTimer &&
          !watch.ran.has(handler) &&
          ms >= TIMER_MIN_MS &&
          ms <= TIMER_MAX_MS;
        let id;
        const callback = function (...callbackArgs) {
          watch.timers.delete(id);
          if (watch.users > 0) {
            watch.ran.add(handler);
          }
          const outer = watch.inTimer;
          watch.inTimer = true;
          try {
            return handler.apply(this, callbackArgs);
          } finally {
            watch.inTimer = outer;
          }
        };
        watch.callbacks.add(callback);
        id = call("setTimeout", [callback, delay, ...args]);
        if (counted) {
          watch.timers.set(id, Date.now());
        }
        return id;
      },
    };
    // Timeouts and intervals share ids, so either can cancel a timeout.
    for (const name of ["clearTimeout", "clearInterval"]) {
      wrappers[name] = function (id) {
        watch.timers.delete(id);
        return call(name, [id]);
      };
    }
    return wrappers;
  }

  function watchTimers() {
    const watch = timerWatch();
    watch.users += 1;
    if (watch.users > 1) {
      return;
    }
    const names = ["setTimeout", "clearTimeout", "clearInterval"];
    const natives = Object.fromEntries(
      names.map((name) => [name, window[name]]),
    );
    const wrappers = timerWrappers(watch, natives);
    for (const name of names) {
      window[name] = wrappers[name];
      watch.installed[name] = {
        native: natives[name],
        wrapper: wrappers[name],
      };
    }
  }

  function unwatchTimers() {
    const watch = window[TIMER_KEY];
    if (!watch || watch.users === 0) {
      return;
    }
    watch.users -= 1;
    if (watch.users > 0) {
      return;
    }
    watch.timers.clear();
    watch.ran = new WeakSet();
    for (const [name, { native, wrapper }] of Object.entries(watch.installed)) {
      if (window[name] === wrapper) {
        window[name] = native;
      }
    }
    watch.installed = {};
  }

  // Timers counted since the state's baseline that have not fired.
  function pendingTimers(state) {
    let pending = 0;
    for (const createdAt of window[TIMER_KEY]?.timers.values() ?? []) {
      if (createdAt >= state.createdAt) {
        pending += 1;
      }
    }
    return pending;
  }

  function startChangeTracking(state) {
    watchTimers();
    if (typeof MutationObserver === "function") {
      state.observer = new MutationObserver((records) =>
        recordMutations(state, records),
      );
      state.observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    changeStates().set(state.id, state);
  }

  function stopChangeTracking(state) {
    state.observer?.disconnect();
    const states = window[CHANGE_KEY];
    if (states?.get(state.id) === state) {
      states.delete(state.id);
      unwatchTimers();
    }
  }

  // Lines for the first CHANGE_CONTROL_LIMIT visible headings and controls,
  // and the set of visible ones past it, so the diff does not mistake an
  // element crossing the limit for one that appeared or disappeared.
  function changeSnapshot() {
    const beyond = new Set();
    const { controls } = snapshotControls({
      headings: true,
      limit: CHANGE_CONTROL_LIMIT,
      locators: false,
      beyond,
    });
    return {
      lines: new Map(
        controls.map((control) => [control.ref, formatSnapshotLine(control)]),
      ),
      beyond,
    };
  }

  // The 1px, clipped live regions that announce to screen readers, which
  // extensions such as password managers add as the page is used.
  function isScreenReaderOnly(element) {
    const rect = element.getBoundingClientRect();
    return rect.width < 2 || rect.height < 2;
  }

  // isShown, unlike isVisible, keeps text under pointer-events: none, such
  // as a toast.
  function shownText(element) {
    return isShown(element) && !isScreenReaderOnly(element)
      ? normalizeText(getVisibleText(element))
      : "";
  }

  // A live region or alert can be revealed by a class or style change alone,
  // which adds no nodes, so its text is compared with the baseline.
  function messageTexts() {
    const texts = new Map();
    const elements = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
    for (const element of elements.slice(0, CHANGE_MESSAGE_LIMIT)) {
      texts.set(element, shownText(element));
    }
    return texts;
  }

  function dropAbandonedStates() {
    const active = Array.isArray(payload.active) ? payload.active : [];
    for (const state of Array.from(changeStates().values())) {
      const abandoned =
        state.owner === payload.owner
          ? !active.includes(state.id)
          : Date.now() - state.createdAt > CHANGE_STALE_MS;
      if (abandoned) {
        stopChangeTracking(state);
      }
    }
  }

  function changeBaseline() {
    dropAbandonedStates();
    pruneRefs(refRegistry());
    const { lines, beyond } = changeSnapshot();
    startChangeTracking({
      id: payload.changeId,
      owner: payload.owner,
      createdAt: Date.now(),
      url: location.href,
      title: document.title,
      lines,
      beyond,
      messages: messageTexts(),
      touched: new Set(),
      revealed: new Set(),
      lastMutationAt: Date.now(),
      observer: null,
    });
    return { documentId: documentId(), nextRef: refRegistry().next };
  }

  function changeStatus() {
    const states = changeStates();
    if (documentId() !== payload.documentId) {
      let watcher = states.get(payload.changeId);
      if (!watcher) {
        watcher = {
          id: payload.changeId,
          owner: payload.owner,
          createdAt: Date.now(),
          touched: new Set(),
          revealed: new Set(),
          lastMutationAt: Date.now(),
          observer: null,
        };
        startChangeTracking(watcher);
      }
      return {
        document: "new",
        readyState: document.readyState,
        quietMs: Date.now() - watcher.lastMutationAt,
        timers: pendingTimers(watcher),
      };
    }
    const state = states.get(payload.changeId);
    if (!state) {
      return { document: "same", lost: true };
    }
    return {
      document: "same",
      quietMs: Date.now() - state.lastMutationAt,
      timers: pendingTimers(state),
    };
  }

  function changeStop() {
    const state = changeStates().get(payload.changeId);
    if (state) {
      stopChangeTracking(state);
    }
    return { stopped: Boolean(state) };
  }

  // A list item wrapping a link says nothing the link's line does not.
  function onlyControlText(element) {
    if (typeof element.querySelectorAll !== "function") {
      return false;
    }
    const controls = Array.from(element.querySelectorAll("*")).filter((node) =>
      CONTROL_ROLES.includes(inferRole(node)),
    );
    if (controls.length === 0) {
      return false;
    }
    const controlText = controls
      .map((control) => normalizeText(getVisibleText(control)))
      .join(" ");
    return normalizeText(controlText) === shownText(element);
  }

  function insideControl(element) {
    for (let node = element; node; node = node.parentElement) {
      if (CONTROL_ROLES.includes(inferRole(node))) {
        return true;
      }
    }
    return false;
  }

  // The visible text of the outermost elements the action added, changed
  // the text of, or revealed, skipping controls, which the diff lists.
  function addedText(state) {
    const candidates = new Set(
      [...state.touched, ...state.revealed].filter(
        (element) => element.isConnected,
      ),
    );
    for (const [element, before] of state.messages) {
      const now = element.isConnected ? shownText(element) : "";
      if (now && now !== before) {
        candidates.add(element);
      }
    }
    const elements = Array.from(candidates);
    const outermost = elements.filter(
      (element) =>
        !elements.some(
          (other) =>
            other !== element &&
            typeof other.contains === "function" &&
            other.contains(element),
        ),
    );
    const items = [];
    let more = 0;
    for (const element of outermost) {
      if (insideControl(element) || onlyControlText(element)) {
        continue;
      }
      const text = clipText(shownText(element), CHANGE_TEXT_CHARS);
      if (!text || items.includes(text)) {
        continue;
      }
      if (items.length >= CHANGE_TEXT_LIMIT) {
        more += 1;
        continue;
      }
      items.push(text);
    }
    return { items, more };
  }

  function capLines(lines) {
    return {
      lines: lines.slice(0, CHANGE_LINE_LIMIT),
      more: Math.max(0, lines.length - CHANGE_LINE_LIMIT),
    };
  }

  function changeReport() {
    const page = { url: location.href, title: document.title };
    const state = changeStates().get(payload.changeId);
    if (documentId() !== payload.documentId) {
      if (state) {
        stopChangeTracking(state);
      }
      const { controls, moreControls, nextRef } = snapshotControls({
        headings: true,
        limit: payload.limit,
        locators: false,
      });
      return {
        newDocument: true,
        ...page,
        nodes: controls.map(formatSnapshotLine),
        more: moreControls,
        nextRef,
      };
    }
    if (!state) {
      return { lost: true, ...page };
    }

    if (state.observer) {
      const records = state.observer.takeRecords();
      if (records.length > 0) {
        recordMutations(state, records);
      }
    }
    stopChangeTracking(state);
    const registry = refRegistry();
    pruneRefs(registry);
    const after = changeSnapshot();
    const added = [];
    const updated = [];
    const removed = [];
    for (const [ref, line] of after.lines) {
      const before = state.lines.get(ref);
      if (before === undefined) {
        if (!state.beyond.has(registry.byRef.get(ref))) {
          added.push(line);
        }
      } else if (before !== line) {
        updated.push(line);
      }
    }
    for (const [ref, line] of state.lines) {
      const element = registry.byRef.get(ref);
      if (!after.lines.has(ref) && !(element && after.beyond.has(element))) {
        removed.push(line);
      }
    }
    return {
      newDocument: false,
      ...page,
      urlChanged: page.url !== state.url,
      titleChanged: page.title !== state.title,
      added: capLines(added),
      removed: capLines(removed),
      updated: capLines(updated),
      text: addedText(state),
      nextRef: registry.next,
    };
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

    if (locator.startsWith("ref=")) {
      const query = locator.slice(4).trim();
      const { element, error } = resolveRef(query);
      const resolved = { locator, strategy: "ref", query, element };
      if (error) {
        resolved.error = error;
      }
      return resolved;
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

  // The element under a point, short: a ref to act on it again, and its
  // role and name when it has a role (a plain element's name would be all
  // of its text).
  function describePointTarget(element) {
    const target = { ref: refFor(element), ...summarizeTarget(element) };
    const role = inferRole(element);
    if (role) {
      target.role = role;
      const name = normalizeText(getAccessibleName(element));
      if (name) {
        target.name = clipText(name, SNAPSHOT_TEXT_LIMIT);
      }
    }
    if (isDisabled(element)) {
      target.disabled = true;
    }
    return target;
  }

  // Firefox starts a native HTML5 drag from WebDriver input but does not
  // finish it, so there an HTML5 drag runs as drag events dispatched here,
  // sharing one DataTransfer as a real drag would. The events are untrusted.
  // check only says whether the element under from is HTML5-draggable.
  function allowedOperations(allowed) {
    if (allowed === "all" || allowed === "uninitialized") {
      return ["copy", "link", "move"];
    }
    return ["copy", "link", "move"].filter((operation) =>
      allowed.toLowerCase().includes(operation),
    );
  }

  // upload_file takes the file input itself, a <label> for one, or an
  // element with one inside (a styled upload area). The input is left on
  // the window under the upload's token for the server to take a handle
  // to, since only the browser protocol can set files.
  const FILE_TARGET_KEY = "__mcpBrowserDevToolsFileTargets";

  function fileInput() {
    const resolved = ensureResolved(payload.selector);
    if (!resolved.element) {
      return resolved;
    }
    const element = resolved.element;
    const isFileInput = (node) =>
      node?.tagName === "INPUT" && node.type === "file";
    const input = isFileInput(element)
      ? element
      : isFileInput(element.control)
        ? element.control
        : (element.querySelector?.('input[type="file"]') ?? null);
    const result = {
      browserFamily: payload.browserFamily,
      selector: payload.selector,
      found: true,
      fileInput: Boolean(input),
    };
    if (!input) {
      return result;
    }
    // Clearing is done here, so both browsers fire input and change.
    if (payload.clear) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ...result, cleared: true };
    }
    (window[FILE_TARGET_KEY] ?? defineHidden(FILE_TARGET_KEY, new Map())).set(
      payload.token,
      input,
    );
    return {
      ...result,
      multiple: Boolean(input.multiple),
      accept: input.accept || null,
      disabled: isDisabled(input),
    };
  }

  // The operation the browser proposes on dragenter and dragover for the
  // operations the source allows, per the HTML drag-and-drop model.
  function defaultDropEffect(allowed, isLink) {
    if (allowed === "none") {
      return "none";
    }
    if (allowed === "link" || allowed === "linkMove") {
      return "link";
    }
    if (allowed === "move") {
      return "move";
    }
    if (allowed === "uninitialized" && isLink) {
      return "link";
    }
    return "copy";
  }

  function html5Drag() {
    const draggable = hitTest(payload.from)?.closest?.(
      '[draggable="true"], a[href]:not([draggable="false"]), img:not([draggable="false"])',
    );
    if (!draggable || payload.check) {
      return { html5: Boolean(draggable) };
    }
    const dataTransfer = new DataTransfer();
    // As in a real drag, dragstart handlers may say which operations they
    // allow, and the browser fills in a link's or image's URL first.
    dataTransfer.effectAllowed = "uninitialized";
    const url =
      draggable.tagName === "A"
        ? draggable.href
        : draggable.tagName === "IMG"
          ? draggable.src
          : null;
    if (url) {
      dataTransfer.setData("text/uri-list", url);
      dataTransfer.setData("text/plain", url);
    }
    const fire = (element, type, point) =>
      element.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: point.x,
          clientY: point.y,
          dataTransfer,
        }),
      );
    if (!fire(draggable, "dragstart", payload.from)) {
      return { html5: true, dropped: false, canceled: true };
    }
    fire(draggable, "drag", payload.from);
    // Read after dragstart, whose handlers may have changed what is there.
    const target = hitTest(payload.to) ?? document.body;
    const effect = defaultDropEffect(
      dataTransfer.effectAllowed,
      draggable.tagName === "A",
    );
    dataTransfer.dropEffect = effect;
    fire(target, "dragenter", payload.to);
    dataTransfer.dropEffect = effect;
    // A target accepts by canceling dragover with an operation the source
    // allows, and takes the drop by canceling drop; otherwise the source
    // sees dropEffect none, as after a real drop nobody took.
    const accepted =
      !fire(target, "dragover", payload.to) &&
      allowedOperations(dataTransfer.effectAllowed).includes(
        dataTransfer.dropEffect,
      );
    const dropped = accepted && !fire(target, "drop", payload.to);
    if (!accepted) {
      fire(target, "dragleave", payload.to);
    }
    if (!dropped) {
      dataTransfer.dropEffect = "none";
    }
    fire(draggable, "dragend", payload.to);
    return { html5: true, dropped };
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

  // Tells input the browser silently dropped apart from input the page
  // received, from the trusted events inputRecorder counted between arming
  // the probe and reading it. A recorder installed when the document started
  // runs before every page listener, so no count means nothing arrived. One
  // installed later can miss events that earlier page listeners stopped, so
  // there a click also counts as delivered when the element under the pointer
  // becomes hovered, and typing when the field's content changes: the
  // browser does both before any page listener runs.
  const INPUT_PROBE_KEY = Symbol.for("mcp-browser-dev-tools.inputProbe");
  const INPUT_RECORDER_KEY = Symbol.for("mcp-browser-dev-tools.inputRecorder");

  // Input aimed at a frame goes to the frame's own document, whose events
  // this window does not see.
  function hostsDocument(element) {
    return ["IFRAME", "FRAME", "OBJECT", "EMBED"].includes(element?.tagName);
  }

  function isHovered(element) {
    try {
      return element.matches(":hover");
    } catch {
      return false;
    }
  }

  function editedContent(element) {
    if (!element) {
      return null;
    }
    return typeof element.value === "string"
      ? element.value
      : element.textContent;
  }

  function armInputProbe(token, kind, options = {}) {
    const recorder = window[INPUT_RECORDER_KEY];
    if (!recorder) {
      delete window[INPUT_PROBE_KEY];
      return;
    }
    const hovered = options.pointerAt ?? null;
    window[INPUT_PROBE_KEY] = {
      token,
      kind,
      count: recorder[kind],
      early: recorder.early,
      element: options.element ?? null,
      locator: options.locator ?? null,
      hovered: hovered && !isHovered(hovered) ? hovered : null,
      edited: options.edited ?? null,
      content: editedContent(options.edited),
    };
  }

  // Unarmed means delivery cannot be checked, for example after the page
  // navigated. conclusive says whether "not delivered" can be trusted.
  function readInputProbe(token, disarm) {
    const probe = window[INPUT_PROBE_KEY];
    const recorder = window[INPUT_RECORDER_KEY];
    if (!probe || probe.token !== token || !recorder) {
      return { armed: false, delivered: false, conclusive: false };
    }
    const delivered =
      recorder[probe.kind] > probe.count ||
      Boolean(probe.hovered && isHovered(probe.hovered)) ||
      (probe.edited !== null && editedContent(probe.edited) !== probe.content);
    if (disarm || delivered) {
      delete window[INPUT_PROBE_KEY];
    }
    return {
      armed: true,
      delivered,
      conclusive: probe.early,
      node:
        delivered && probe.element?.isConnected
          ? describeElement(probe.element, probe.locator)
          : null,
    };
  }

  // Whether the page renders the element at all. innerText falls back to the
  // raw text content for an element inside display: none, which the page
  // does not show; unlike isVisible, size and pointer events do not matter.
  function isRendered(element) {
    for (let node = element; node; node = node.parentElement) {
      if (getComputedStyle(node).display === "none") {
        return false;
      }
    }
    return true;
  }

  // Rendered and not hidden by visibility, for choosing the main content and
  // links; computed visibility already reflects hidden ancestors.
  function isShown(element) {
    const visibility = getComputedStyle(element).visibility;
    return (
      isRendered(element) &&
      visibility !== "hidden" &&
      visibility !== "collapse"
    );
  }

  // Readable text of one element, or of the page's main content: main or
  // role=main, else a single article, else the body. Lines keep their
  // breaks with runs of spaces and blank lines collapsed.
  function readText() {
    let root;
    let source;
    if (payload.selector) {
      const resolved = ensureResolved(payload.selector);
      if (!resolved.element) {
        return resolved;
      }
      root = resolved.element;
      source = "selector";
    } else {
      const main = [...document.querySelectorAll("main, [role=main]")].find(
        isShown,
      );
      const articles = [...document.querySelectorAll("article")].filter(
        isShown,
      );
      if (main) {
        root = main;
        source = "main";
      } else if (articles.length === 1) {
        root = articles[0];
        source = "article";
      } else {
        root = document.body ?? document.documentElement;
        source = "body";
      }
    }

    const shown = source !== "selector" || isRendered(root);
    const raw = !shown
      ? ""
      : typeof root.innerText === "string"
        ? root.innerText
        : root.textContent;
    const text = (raw ?? "")
      .split("\n")
      .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const result = {
      browserFamily: payload.browserFamily,
      url: location.href,
      title: document.title,
      source,
      ...(payload.selector
        ? { selector: payload.selector, found: true, visible: shown }
        : {}),
      text: text.slice(0, payload.maxChars),
      totalChars: text.length,
      truncated: text.length > payload.maxChars,
    };

    if (payload.links) {
      const seen = new Set();
      const links = [];
      for (const anchor of root.querySelectorAll("a[href]")) {
        const href = anchor.href;
        if (!/^https?:/i.test(href) || seen.has(href) || !isShown(anchor)) {
          continue;
        }
        seen.add(href);
        links.push({
          text: normalizeText(
            anchor.innerText || anchor.getAttribute("aria-label") || "",
          ),
          href,
        });
      }
      result.links = links.slice(0, payload.maxLinks);
      result.moreLinks = Math.max(0, links.length - payload.maxLinks);
    }

    return result;
  }

  function runAction() {
    switch (payload.action) {
      case "read_text":
        return readText();
      case "snapshot":
        return snapshotPage();
      case "change_baseline":
        return changeBaseline();
      case "change_status":
        return changeStatus();
      case "change_report":
        return changeReport();
      case "change_stop":
        return changeStop();
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
        if (
          receivesEvents &&
          typeof payload.inputProbe === "string" &&
          !hostsDocument(hit) &&
          !isDisabled(resolved.element)
        ) {
          armInputProbe(payload.inputProbe, "pointer", {
            element: resolved.element,
            locator: resolved,
            pointerAt: hit,
          });
        }

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
      case "point_target": {
        // Coordinates are CSS pixels from the viewport's top-left corner, as
        // the browser's input takes them.
        const point = { x: Number(payload.x), y: Number(payload.y) };
        const result = {
          browserFamily: payload.browserFamily,
          point,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
        if (
          !(point.x >= 0 && point.x < window.innerWidth) ||
          !(point.y >= 0 && point.y < window.innerHeight)
        ) {
          return {
            ...result,
            found: false,
            error:
              "Point (" +
              point.x +
              ", " +
              point.y +
              ") is outside the viewport (" +
              window.innerWidth +
              "x" +
              window.innerHeight +
              "); scroll first, or use a selector",
          };
        }
        const hit = hitTest(point);
        if (
          hit &&
          typeof payload.inputProbe === "string" &&
          !hostsDocument(hit) &&
          !isDisabled(hit)
        ) {
          armInputProbe(payload.inputProbe, "pointer", {
            element: hit,
            pointerAt: hit,
          });
        }
        return {
          ...result,
          found: true,
          target: hit ? describePointTarget(hit) : null,
          nextRef: refRegistry().next,
        };
      }
      case "html5_drag":
        return html5Drag();
      case "file_input":
        return fileInput();
      case "input_probe":
        return readInputProbe(payload.token, payload.disarm === true);
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

        if (typeof payload.inputProbe === "string") {
          armInputProbe(payload.inputProbe, "keyboard", {
            element,
            locator: resolved,
            edited: element,
          });
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

        const focused = getDeepActiveElement() ?? document.body;
        if (typeof payload.inputProbe === "string" && !hostsDocument(focused)) {
          armInputProbe(payload.inputProbe, "keyboard", {
            edited: isEditable(focused) ? focused : null,
          });
        }

        return {
          browserFamily: payload.browserFamily,
          selector: payload.selector ?? null,
          found: true,
          target: summarizeTarget(focused),
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

// Counts trusted pointer and keyboard events in the page from the moment it
// runs, for the input probe in pageScript. Registered to run when each new
// document starts (early), it sees every event before page listeners can
// stop it; run on a document that is already loaded, it misses what
// listeners added before it stop. Like pageScript, it is serialized with
// toString() and must not reference anything outside itself.
export function inputRecorder(early) {
  const key = Symbol.for("mcp-browser-dev-tools.inputRecorder");
  if (window[key]) {
    return;
  }
  const counts = { pointer: 0, keyboard: 0, early };
  const kinds = {
    pointer: ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
    keyboard: ["keydown", "keyup", "beforeinput", "input"],
  };
  for (const [kind, types] of Object.entries(kinds)) {
    for (const type of types) {
      window.addEventListener(
        type,
        (event) => {
          if (event.isTrusted) {
            counts[kind] += 1;
          }
        },
        true,
      );
    }
  }
  Object.defineProperty(window, key, { value: counts });
}
