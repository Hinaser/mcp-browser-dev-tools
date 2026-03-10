function buildPayloadLiteral(payload) {
  return JSON.stringify(payload);
}

export function buildPageContextExpression(
  payload,
  { serialize = false } = {},
) {
  const body = `(() => {
    const payload = ${buildPayloadLiteral(payload)};
    const TEXT_LIMIT = 400;

    function clipText(value, limit = TEXT_LIMIT) {
      if (typeof value !== "string") {
        return value ?? null;
      }

      return value.length > limit ? \`\${value.slice(0, limit)}...\` : value;
    }

    function normalizeText(value) {
      return typeof value === "string"
        ? value.replace(/\\s+/g, " ").trim()
        : "";
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

    function getLabelTextForControl(element) {
      if (!element || !element.id) {
        return "";
      }

      const label = document.querySelector(\`label[for="\${CSS.escape(element.id)}"]\`);
      return label ? normalizeText(getVisibleText(label)) : "";
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
          .split(/\\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => normalizeText(getVisibleText(node)))
          .filter(Boolean)
          .join(" ");
        if (text) {
          return text;
        }
      }

      const labelText = getLabelTextForControl(element);
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
        return normalizeText(element.value);
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
        if (type === "button" || type === "submit" || type === "reset") return "button";
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

    function isDisabled(element) {
      return Boolean(
        element &&
          (element.disabled === true ||
            element.getAttribute("aria-disabled") === "true"),
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
      for (const key of ["locator", "strategy", "query", "role", "name", "error"]) {
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
      const match = value.match(/^([^\\[]+?)(?:\\[name=(?:"([^"]*)"|'([^']*)')\\])?$/);
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
      return Array.from(
        document.querySelectorAll("body *"),
      );
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
        const match =
          candidates.find((element) => {
            const accessibleName = normalizeText(getAccessibleName(element));
            return isVisible(element) && accessibleName === query;
          }) ??
          candidates.find((element) => {
            const accessibleName = normalizeText(getAccessibleName(element));
            return (
              isVisible(element) && accessibleName && accessibleName.includes(query)
            );
          });

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
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    function maybeScrollIntoView(element) {
      if (!element || payload.scrollIntoView === false) {
        return;
      }

      element.scrollIntoView({ block: "center", inline: "center" });
    }

    function pressKeyOnTarget(target, key) {
      const eventInit = {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }

    function runAction() {
      switch (payload.action) {
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
          };
        }
        case "click": {
          const resolved = ensureResolved(payload.selector);
          if (!resolved.element) {
            return resolved;
          }

          maybeScrollIntoView(resolved.element);
          if (typeof resolved.element.focus === "function") {
            resolved.element.focus();
          }

          if (typeof resolved.element.click === "function") {
            resolved.element.click();
          } else {
            resolved.element.dispatchEvent(
              new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
              }),
            );
          }

          return {
            browserFamily: payload.browserFamily,
            selector: payload.selector,
            found: true,
            clicked: true,
            node: describeElement(resolved.element, resolved),
          };
        }
        case "hover": {
          const resolved = ensureResolved(payload.selector);
          if (!resolved.element) {
            return resolved;
          }

          maybeScrollIntoView(resolved.element);
          const eventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
          };
          resolved.element.dispatchEvent(new MouseEvent("mouseover", eventInit));
          resolved.element.dispatchEvent(new MouseEvent("mouseenter", eventInit));
          resolved.element.dispatchEvent(new MouseEvent("mousemove", eventInit));

          return {
            browserFamily: payload.browserFamily,
            selector: payload.selector,
            found: true,
            hovered: true,
            node: describeElement(resolved.element, resolved),
          };
        }
        case "type": {
          const resolved = ensureResolved(payload.selector);
          if (!resolved.element) {
            return resolved;
          }

          const clear = payload.clear !== false;
          maybeScrollIntoView(resolved.element);
          if (typeof resolved.element.focus === "function") {
            resolved.element.focus();
          }

          if (
            resolved.element instanceof HTMLInputElement ||
            resolved.element instanceof HTMLTextAreaElement
          ) {
            resolved.element.value = clear
              ? payload.text
              : \`\${resolved.element.value}\${payload.text}\`;
            dispatchInputEvents(resolved.element);
          } else if (resolved.element.isContentEditable) {
            resolved.element.textContent = clear
              ? payload.text
              : \`\${resolved.element.textContent ?? ""}\${payload.text}\`;
            dispatchInputEvents(resolved.element);
          } else {
            throw new Error("Resolved element is not editable");
          }

          return {
            browserFamily: payload.browserFamily,
            selector: payload.selector,
            found: true,
            typedText: payload.text,
            node: describeElement(resolved.element, resolved),
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
        case "press_key": {
          let target = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : document.body;

          if (payload.selector) {
            const resolved = ensureResolved(payload.selector);
            if (!resolved.element) {
              return resolved;
            }

            maybeScrollIntoView(resolved.element);
            if (typeof resolved.element.focus === "function") {
              resolved.element.focus();
            }
            target = resolved.element;
          }

          pressKeyOnTarget(target, payload.key);

          return {
            browserFamily: payload.browserFamily,
            key: payload.key,
            dispatched: true,
            target: target
              ? {
                  tagName: target.tagName,
                  id: target.getAttribute("id"),
                  className: target.getAttribute("class"),
                }
              : null,
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
            requestId: \`snapshot-\${index + 1}-\${entry.name || "entry"}\`,
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
            const safeEntries = Array.isArray(entries) ? entries.slice(0, 100) : [];
            if (clearStorage) {
              storage.clear();
            }

            for (const entry of safeEntries) {
              if (!entry || typeof entry.key !== "string") {
                continue;
              }

              storage.setItem(entry.key, typeof entry.value === "string" ? entry.value : "");
            }

            return safeEntries.length;
          };

          const restoreCookies = (entries) => {
            const safeEntries = Array.isArray(entries) ? entries.slice(0, 100) : [];
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
          throw new Error(\`Unsupported page action: \${payload.action}\`);
      }
    }

    return runAction();
  })()`;

  return serialize ? `JSON.stringify(${body})` : body;
}
