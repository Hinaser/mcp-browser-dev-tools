import { retryUntilActionable } from "../action-retry.mjs";
import { parseKeyCombo } from "../keyboard.mjs";
import {
  DEFAULT_DRAG_STEPS,
  MOUSE_BUTTONS,
  parseFrameRef,
} from "../page-context.mjs";
import { allowedUploadDirs, resolveUploadPaths } from "../upload-files.mjs";
import {
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
  return server.changeTracker.around(
    args.sessionId,
    action,
    parseFrameRef(args.selector)?.frameKey ?? null,
  );
}

export function actionTools(server) {
  return [
    [
      "navigate",
      {
        definition: {
          name: "navigate",
          description: "Load a URL.",
          inputSchema: sessionSchema(
            {
              url: {
                type: "string",
                description: "Absolute URL.",
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
          description: "Reload the tab.",
          inputSchema: sessionSchema(
            {
              ignoreCache: {
                type: "boolean",
                description: "Bypass the cache.",
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
            "Click with real mouse input at an element's center (fails if something covers it) or at x, y. Accepts alert and confirm dialogs, dismisses prompts. Returns changes: what changed on the page.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              button: {
                type: "string",
                enum: MOUSE_BUTTONS,
                description: "Default left.",
              },
              clickCount: {
                type: "integer",
                minimum: 1,
                maximum: 3,
                description: "2 for a double click.",
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
            "Move the real mouse pointer to an element's center or x, y. Returns changes.",
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
            "Drag with real mouse input from selector or x, y to toSelector or toX, toY, both in view; handles HTML5 and pointer-driven drags. Returns changes.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              toSelector: {
                type: "string",
                description: "Drop target locator.",
              },
              ...pointProperties("to"),
              steps: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: `Moves (default ${DEFAULT_DRAG_STEPS}).`,
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
            "Type with real text input into an input, textarea, or contenteditable, replacing its content unless clear is false. Returns changes.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              text: {
                type: "string",
                description:
                  "Each newline presses Enter. Picker inputs (date, time, datetime-local, month, week, color, range) take their value format, e.g. 2026-09-27.",
              },
              clear: {
                type: "boolean",
                description:
                  "false appends (default true); picker inputs are always replaced.",
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
      "upload_file",
      {
        definition: {
          name: "upload_file",
          description:
            "Set files on a file input (or its label, or an element holding one; on Chromium also a button that opens a file chooser) and fire change events. Files must be in the working or temp directory or MCP_BROWSER_UPLOAD_DIRS. Returns changes.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              paths: {
                type: "array",
                maxItems: 20,
                items: { type: "string" },
                description: "Absolute file paths; [] clears the input.",
              },
              timeoutMs: actionTimeoutProperty(""),
            },
            ["selector", "paths"],
          ),
        },
        handler: async (args, options) => {
          const files = await resolveUploadPaths(
            args.paths,
            await allowedUploadDirs(server.config),
          );
          return reportChanges(server, args, options, () =>
            retryUntilActionable(
              () =>
                server.browserAdapter.uploadFiles(
                  args.sessionId,
                  args.selector,
                  files,
                ),
              args.timeoutMs,
            ),
          );
        },
      },
    ],
    [
      "select",
      {
        definition: {
          name: "select",
          description:
            "Pick a native <select> option by value or label and fire change events; use click for custom dropdowns. Returns changes.",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              value: {
                type: "string",
                description: "Option value or full text.",
              },
              label: {
                type: "string",
                description: "Text the option contains.",
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
            "Press a key or combination with real keyboard input on selector (focused first) or the focused element. Returns changes.",
          inputSchema: sessionSchema(
            {
              key: {
                type: "string",
                description:
                  "A character or key name (Enter, Tab, Escape, ArrowDown, PageUp, F5, ...); join modifiers with +, e.g. Shift+Tab, Meta+a.",
              },
              selector: selectorProperty(),
              timeoutMs: actionTimeoutProperty(""),
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
            "Scroll the page by deltas, an element into view, or with a real wheel at x, y or over selector with deltas (scrolls what is under the pointer).",
          inputSchema: sessionSchema(
            {
              selector: selectorProperty(),
              ...pointProperties(),
              deltaX: {
                type: "integer",
                description: "CSS px; negative is left.",
              },
              deltaY: {
                type: "integer",
                description: "CSS px; negative is up.",
              },
              block: {
                type: "string",
                enum: ["start", "center", "end", "nearest"],
                description: "Default center.",
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
          description: "Override the viewport size.",
          inputSchema: sessionSchema(
            {
              width: {
                type: "integer",
                minimum: 1,
                description: "CSS px.",
              },
              height: {
                type: "integer",
                minimum: 1,
                description: "CSS px.",
              },
              deviceScaleFactor: {
                type: "number",
                minimum: 0.1,
                description: "Device pixel ratio (Chromium default 1).",
              },
              mobile: {
                type: "boolean",
                description: "Mobile emulation (Chromium only).",
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
