import { retryUntilActionable } from "../action-retry.mjs";
import { parseKeyCombo } from "../keyboard.mjs";
import {
  actionTimeoutProperty,
  selectorProperty,
  sessionSchema,
  waitUntilProperty,
} from "../tool-schemas.mjs";

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
            "Click a single element located by CSS, text=..., role=..., or name=... syntax. Sends real mouse input at the element center and fails if another element covers that point. A JavaScript alert or confirm dialog that this opens is accepted automatically and a prompt is dismissed; get_events reports it as a dialog event. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              timeoutMs: actionTimeoutProperty(
                ", covered, outside the viewport, or disabled",
              ),
            },
            ["selector"],
          ),
        },
        handler: async (args) =>
          retryUntilActionable(
            () => server.browserAdapter.click(args.sessionId, args.selector),
            args.timeoutMs,
          ),
      },
    ],
    [
      "hover",
      {
        definition: {
          name: "hover",
          description:
            "Hover a single element located by CSS, text=..., role=..., or name=... syntax. Moves the real mouse pointer to the element center.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              timeoutMs: actionTimeoutProperty(
                ", covered, or outside the viewport",
              ),
            },
            ["selector"],
          ),
        },
        handler: async (args) =>
          retryUntilActionable(
            () => server.browserAdapter.hover(args.sessionId, args.selector),
            args.timeoutMs,
          ),
      },
    ],
    [
      "type",
      {
        definition: {
          name: "type",
          description:
            "Type text into an input, textarea, or contenteditable element using real text input, replacing existing content unless clear is false. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              text: {
                type: "string",
                description:
                  "Text to enter. Each newline is sent as an Enter key press: a line break in a textarea, implicit form submission in a single-line input. Date, time, datetime-local, month, week, color, and range inputs get the value set directly, so pass it in that input's value format (for example 2026-09-27). An empty string with clear empties the field.",
              },
              clear: {
                type: "boolean",
                description:
                  "Replace the existing content (default true). When false, the text is inserted at the end of the current content. Ignored for date, time, datetime-local, month, week, color, and range inputs, whose value is always replaced.",
              },
              timeoutMs: actionTimeoutProperty(""),
            },
            ["selector", "text"],
          ),
        },
        handler: async (args) =>
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
      },
    ],
    [
      "select",
      {
        definition: {
          name: "select",
          description:
            "Select an option in a native <select> element and fire input and change events. Provide value, label, or both; the first option matching either is selected, and the call fails if none matches. Custom dropdowns built from other elements need click instead. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
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
        handler: async (args) =>
          retryUntilActionable(
            () =>
              server.browserAdapter.select(args.sessionId, args.selector, {
                value: args.value,
                label: args.label,
              }),
            args.timeoutMs,
          ),
      },
    ],
    [
      "press_key",
      {
        definition: {
          name: "press_key",
          description:
            "Press a key or key combination (for example Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a) with real keyboard input on the focused element, or on selector after focusing it. Fails if selector cannot take focus. A JavaScript alert or confirm dialog that this opens is accepted automatically and a prompt is dismissed; get_events reports it as a dialog event. To check the result in the same call, run it as a run_steps step followed by wait_for, inspect_element, or take_screenshot.",
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
        handler: async (args) =>
          retryUntilActionable(
            () =>
              server.browserAdapter.pressKey(
                args.sessionId,
                args.key,
                args.selector,
              ),
            args.selector ? args.timeoutMs : 0,
          ),
      },
    ],
    [
      "scroll",
      {
        definition: {
          name: "scroll",
          description:
            "Scroll the page by deltas or scroll a specific element into view.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              deltaX: {
                type: "integer",
                description:
                  "Horizontal scroll distance in CSS pixels; negative scrolls left. Ignored when selector is given.",
              },
              deltaY: {
                type: "integer",
                description:
                  "Vertical scroll distance in CSS pixels; negative scrolls up. Ignored when selector is given.",
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
          if (
            !args.selector &&
            args.deltaX === undefined &&
            args.deltaY === undefined
          ) {
            throw new Error(
              "scroll requires either selector or deltaX/deltaY values",
            );
          }
        },
        handler: async (args) =>
          server.browserAdapter.scroll(args.sessionId, {
            selector: args.selector,
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
