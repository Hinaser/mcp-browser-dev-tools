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
