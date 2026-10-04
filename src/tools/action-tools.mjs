import { retryUntilActionable } from "../action-retry.mjs";
import { parseKeyCombo } from "../keyboard.mjs";
import { DEFAULT_DRAG_STEPS, MOUSE_BUTTONS } from "../page-context.mjs";
import {
  LOCATOR_DESCRIPTION,
  actionTimeoutProperty,
  pointProperties,
  pointerTarget,
  selectorProperty,
  sessionSchema,
  waitUntilProperty,
} from "../tool-schemas.mjs";

// Runs an action and adds what it changed on the page as changes, unless the
// caller (run_steps) reports the changes of the whole batch instead.
function reportChanges(server, args, options, action) {
  if (options?.reportChanges === false || !server.changeTracker) {
    return action();
  }
  return server.changeTracker.around(args.sessionId, action);
}

export function actionTools(server) {
  return [
    [
      "navigate",
      {
        definition: {
          name: "navigate",
          description:
            "Navigate an attached tab to a URL and optionally wait for interactive or complete load state.",
          inputSchema: sessionSchema(
            {
              url: {
                type: "string",
                description: "Absolute URL to load.",
              },
              waitUntil: waitUntilProperty(),
            },
            ["url"],
          ),
        },
        handler: async (args) =>
          server.browserAdapter.navigate(args.sessionId, args.url, {
            waitUntil: args.waitUntil,
          }),
      },
    ],
    [
      "reload",
      {
        definition: {
          name: "reload",
          description:
            "Reload the attached tab and optionally ignore cache while waiting for interactive or complete load state.",
          inputSchema: sessionSchema(
            {
              ignoreCache: {
                type: "boolean",
                description:
                  "Bypass the HTTP cache for this reload (default false).",
              },
              waitUntil: waitUntilProperty(),
            },
            [],
          ),
        },
        handler: async (args) =>
          server.browserAdapter.reload(args.sessionId, {
            ignoreCache: args.ignoreCache,
            waitUntil: args.waitUntil,
          }),
      },
    ],
    [
      "click",
      {
        definition: {
          name: "click",
          description:
            "Click an element with real mouse input at its center, or the point x, y; fails if another element covers the element. button and clickCount give right, middle, and double clicks. Accepts an alert or confirm dialog it opens and dismisses a prompt (get_events reports it). Returns changes, what it changed on the page; batch actions with run_steps.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              button: {
                type: "string",
                enum: MOUSE_BUTTONS,
                description: "Mouse button (default left).",
              },
              clickCount: {
                type: "integer",
                minimum: 1,
                maximum: 3,
                description:
                  "2 for a double click, 3 for a triple click (default 1).",
              },
              timeoutMs: actionTimeoutProperty(
                ", covered, outside the viewport, or disabled",
              ),
            },
            [],
          ),
        },
        validate: (args) => {
          pointerTarget(args);
        },
        handler: async (args, options) =>
          reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.click(
                  args.sessionId,
                  pointerTarget(args),
                  { button: args.button, clickCount: args.clickCount },
                ),
              args.timeoutMs,
            ),
          ),
      },
    ],
    [
      "hover",
      {
        definition: {
          name: "hover",
          description:
            "Move the real mouse pointer to an element's center, or to the point x, y. Returns changes, what it changed on the page.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              timeoutMs: actionTimeoutProperty(
                ", covered, or outside the viewport",
              ),
            },
            [],
          ),
        },
        validate: (args) => {
          pointerTarget(args);
        },
        handler: async (args, options) =>
          reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.hover(
                  args.sessionId,
                  pointerTarget(args),
                ),
              args.timeoutMs,
            ),
          ),
      },
    ],
    [
      "drag",
      {
        definition: {
          name: "drag",
          description:
            "Drag with real mouse input: press on selector (or at x, y), move in steps, and release on toSelector (or at toX, toY). Works for HTML5 draggable elements and for pages that follow mouse or pointer events (sliders, sortable lists, canvases). Both points must be in the viewport; the source is scrolled into view, the drop point is not. Returns changes, what it changed on the page.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              toSelector: {
                type: "string",
                description: `Where to drop. ${LOCATOR_DESCRIPTION}`,
              },
              ...pointProperties("to"),
              steps: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: `Pointer moves between press and release (default ${DEFAULT_DRAG_STEPS}).`,
              },
              timeoutMs: actionTimeoutProperty(
                ", covered, or outside the viewport",
              ),
            },
            [],
          ),
        },
        validate: (args) => {
          pointerTarget(args);
          pointerTarget(args, "to");
        },
        handler: async (args, options) =>
          reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.drag(
                  args.sessionId,
                  pointerTarget(args),
                  pointerTarget(args, "to"),
                  { steps: args.steps },
                ),
              args.timeoutMs,
            ),
          ),
      },
    ],
    [
      "type",
      {
        definition: {
          name: "type",
          description:
            "Type into an input, textarea, or contenteditable with real text input, replacing its content unless clear is false. Returns changes, what it changed on the page; batch actions with run_steps.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              text: {
                type: "string",
                description:
                  "Text to enter; each newline is an Enter press (a line break in a textarea, form submission in a single-line input). Date, time, datetime-local, month, week, color, and range inputs get the value set directly, in their value format (for example 2026-09-27). An empty string with clear empties the field.",
              },
              clear: {
                type: "boolean",
                description:
                  "Replace the existing content (default true); false inserts at the end. The picker inputs listed under text are always replaced.",
              },
              timeoutMs: actionTimeoutProperty(""),
            },
            ["selector", "text"],
          ),
        },
        handler: async (args, options) =>
          reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.type(
                  args.sessionId,
                  args.selector,
                  args.text,
                  { clear: args.clear },
                ),
              args.timeoutMs,
            ),
          ),
      },
    ],
    [
      "select",
      {
        definition: {
          name: "select",
          description:
            "Select an option in a native <select> by value or label (the first option matching either) and fire input and change events; fails if none matches. Use click for custom dropdowns. Returns changes, what it changed on the page; batch actions with run_steps.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              value: {
                type: "string",
                description:
                  "Matches an option whose value attribute or full text equals this string.",
              },
              label: {
                type: "string",
                description:
                  "Matches an option whose visible text contains this string (case-sensitive).",
              },
              timeoutMs: actionTimeoutProperty(""),
            },
            ["selector"],
          ),
        },
        validate: (args) => {
          if (!args.value && !args.label) {
            throw new Error("select requires either value or label");
          }
        },
        handler: async (args, options) =>
          reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.select(args.sessionId, args.selector, {
                  value: args.value,
                  label: args.label,
                }),
              args.timeoutMs,
            ),
          ),
      },
    ],
    [
      "press_key",
      {
        definition: {
          name: "press_key",
          description:
            "Press a key or combination with real keyboard input on the focused element, or on selector after focusing it (fails if it cannot take focus). Accepts an alert or confirm dialog it opens and dismisses a prompt (get_events reports it). Returns changes, what it changed on the page; batch actions with run_steps.",
          inputSchema: sessionSchema(
            {
              key: {
                type: "string",
                description:
                  "A single character, or a named key: Enter, Tab, Escape, Backspace, Delete, Insert, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, F1-F12, Shift, Control, Alt, or Meta. Join modifiers with + (Shift+Tab, Control+Enter, Meta+a). Names are case-insensitive; unknown names are rejected.",
              },
              selector: selectorProperty(),
              timeoutMs: actionTimeoutProperty("; only applies with selector"),
            },
            ["key"],
          ),
        },
        validate: (args) => {
          parseKeyCombo(args.key);
        },
        handler: async (args, options) =>
          reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.pressKey(
                  args.sessionId,
                  args.key,
                  args.selector,
                ),
              args.selector ? args.timeoutMs : 0,
            ),
          ),
      },
    ],
    [
      "scroll",
      {
        definition: {
          name: "scroll",
          description:
            "Scroll the page by deltas, scroll an element into view, or send a real mouse wheel at the point x, y or over selector with deltas, which scrolls whatever is under the pointer (a list or map inside the page).",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              deltaX: {
                type: "integer",
                description:
                  "Horizontal scroll distance in CSS pixels; negative scrolls left.",
              },
              deltaY: {
                type: "integer",
                description:
                  "Vertical scroll distance in CSS pixels; negative scrolls up.",
              },
              block: {
                type: "string",
                enum: ["start", "center", "end", "nearest"],
                description:
                  "Vertical alignment when scrolling selector into view (default center).",
              },
            },
            [],
          ),
        },
        validate: (args) => {
          const target = pointerTarget(args, "", false);
          const deltas = args.deltaX !== undefined || args.deltaY !== undefined;
          if (!target && !deltas) {
            throw new Error(
              "scroll requires either selector or deltaX/deltaY values",
            );
          }
          if (target && typeof target !== "string" && !deltas) {
            throw new Error("scroll at x, y requires deltaX or deltaY");
          }
        },
        handler: async (args) =>
          server.browserAdapter.scroll(args.sessionId, {
            selector: args.selector,
            x: args.x,
            y: args.y,
            deltaX: args.deltaX,
            deltaY: args.deltaY,
            block: args.block,
          }),
      },
    ],
    [
      "set_viewport",
      {
        definition: {
          name: "set_viewport",
          description:
            "Override the page viewport to a specific width and height for responsive debugging.",
          inputSchema: sessionSchema(
            {
              width: {
                type: "integer",
                minimum: 1,
                description: "Viewport width in CSS pixels.",
              },
              height: {
                type: "integer",
                minimum: 1,
                description: "Viewport height in CSS pixels.",
              },
              deviceScaleFactor: {
                type: "number",
                minimum: 0.1,
                description:
                  "Device pixel ratio to emulate. Chromium and Edge use 1 when omitted; Firefox keeps its current ratio.",
              },
              mobile: {
                type: "boolean",
                description:
                  "Emulate a mobile device, including meta viewport handling (default false). Chromium and Edge only; ignored on Firefox.",
              },
            },
            ["width", "height"],
          ),
        },
        handler: async (args) =>
          server.browserAdapter.setViewport(args.sessionId, {
            width: args.width,
            height: args.height,
            deviceScaleFactor: args.deviceScaleFactor,
            mobile: args.mobile,
          }),
      },
    ],
  ];
}
