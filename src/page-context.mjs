import { inputRecorder, pageScript } from "./page-script.mjs";

const PAGE_SCRIPT_SOURCE = pageScript.toString();

// The input recorder as a function declaration, to run with early = true
// when each new document starts or false on the current document.
export const INPUT_RECORDER_FUNCTION = inputRecorder.toString();

export function buildInputRecorderExpression(early) {
  return `(${INPUT_RECORDER_FUNCTION})(${early})`;
}

// Builds an expression that runs pageScript in the page with this payload.
// With serialize, the expression evaluates to the result as a JSON string.
export function buildPageContextExpression(
  payload,
  { serialize = false } = {},
) {
  const body = `(${PAGE_SCRIPT_SOURCE})(${JSON.stringify(payload)})`;
  return serialize ? `JSON.stringify(${body})` : body;
}

// Refs (e12) are numbered per page from refStart. The server remembers the
// page's next ref on the session and passes it on, so numbering continues
// across navigations and a ref from an earlier page never resolves on a
// later one. The page reports nextRef with each snapshot; it is bookkeeping,
// so it is removed from the result.
export function takeNextRef(session, result) {
  if (result && typeof result === "object" && "nextRef" in result) {
    const { nextRef, ...rest } = result;
    if (Number.isInteger(nextRef) && nextRef > (session.refStart ?? 1)) {
      session.refStart = nextRef;
    }
    return rest;
  }
  return result;
}

function describeTarget(target) {
  if (!target) {
    return "another element";
  }

  const id = target.id ? `#${target.id}` : "";
  const className =
    typeof target.className === "string" && target.className.trim()
      ? `.${target.className.trim().split(/\s+/).join(".")}`
      : "";
  return `<${target.tagName.toLowerCase()}${id}${className}>`;
}

// Marks errors for elements that may become usable soon, such as one still
// covered by a banner, so actions can retry them until their timeout.
export const ELEMENT_NOT_ACTIONABLE = "ELEMENT_NOT_ACTIONABLE";

function notActionable(message) {
  const error = new Error(message);
  error.code = ELEMENT_NOT_ACTIONABLE;
  return error;
}

// Real pointer input lands on whatever is painted at the point, so refuse to
// send it when the resolved element is off-screen or covered.
export function assertPointerTarget(target) {
  if (!target.found) {
    return;
  }

  if (!target.point) {
    throw notActionable(
      `Element "${target.selector}" has no visible area inside the viewport`,
    );
  }

  if (!target.receivesEvents) {
    const { x, y } = target.point;
    throw notActionable(
      `Element "${target.selector}" is covered by ${describeTarget(target.obscuredBy)} at (${Math.round(x)}, ${Math.round(y)}); close or scroll past the covering element first`,
    );
  }
}

// A click on a disabled control does nothing, so report it instead.
export function assertEnabled(target) {
  if (target.found && target.node?.disabled === true) {
    throw notActionable(`Element "${target.selector}" is disabled`);
  }
}

// A pointer target is a locator, which resolves to the center of its
// element's visible area, or viewport coordinates { x, y } in CSS pixels.
export function describePointer(target) {
  return typeof target === "string"
    ? `"${target}"`
    : `(${target.x}, ${target.y})`;
}

// The fields an action reports about where it acted: the selector and its
// element, or the element found at the coordinates.
export function pointerFields(target, resolved, node = resolved.node) {
  return typeof target === "string"
    ? { selector: target, point: resolved.point, node }
    : { point: resolved.point, target: resolved.target };
}

// A drag reports where it pressed and released, without element details.
export function dragEnd(target, resolved) {
  return typeof target === "string"
    ? { selector: target, point: resolved.point }
    : { point: resolved.point, target: resolved.target };
}

export const DEFAULT_DRAG_STEPS = 10;

// The points a drag moves through after pressing at from, ending at to, so
// pages that track the pointer see a path rather than a jump.
export function dragPath(from, to, steps = DEFAULT_DRAG_STEPS) {
  return Array.from({ length: steps }, (_, index) => {
    const fraction = (index + 1) / steps;
    return {
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
    };
  });
}

export const MOUSE_BUTTONS = ["left", "middle", "right"];

// Whether scroll sends a mouse wheel rather than scrolling from the page.
export function wheelScroll(options) {
  const deltas = options.deltaX !== undefined || options.deltaY !== undefined;
  return options.x !== undefined || Boolean(options.selector && deltas);
}

// An expression that takes the file input fileInput() left on the window
// under token, removing it there.
export function takeFileTarget(token) {
  const key = JSON.stringify(token);
  return `(() => { const targets = window.__mcpBrowserDevToolsFileTargets; const input = targets?.get(${key}); targets?.delete(${key}); return input; })()`;
}

// Checks a file input before files are set on it.
export function assertFileInput(target, files) {
  if (target.disabled) {
    throw notActionable(`File input "${target.selector}" is disabled`);
  }
  if (files.length > 1 && !target.multiple) {
    throw new Error(
      `File input "${target.selector}" takes one file, not ${files.length}`,
    );
  }
}

export function uploadResult(browserFamily, selector, files, extra = {}) {
  return {
    browserFamily,
    selector,
    found: true,
    uploaded: files.map((file) => file.split(/[\\/]/).pop()),
    ...extra,
  };
}
