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

// Frames: get_snapshot lists the controls inside iframes with refs like
// f2e7, element e7 of frame f2. The server keeps the frame keys; a tool
// given such a ref runs its page action in that frame, with the ref
// rewritten to the frame's own e7, and shifts the points it reports by the
// frame's position, so input lands where the element is.
export const MAX_SNAPSHOT_FRAMES = 10;

export function parseFrameRef(selector) {
  const match =
    typeof selector === "string"
      ? selector.trim().match(/^ref=f(\d+)(e\d+)$/)
      : null;
  return match
    ? { frameKey: `f${match[1]}`, selector: `ref=${match[2]}` }
    : null;
}

// Frame keys for one session, stable for a frame while it exists. Each
// frame carries its own next ref, as the session does for the top page.
export class FrameKeys {
  constructor() {
    this.byKey = new Map();
    this.byId = new Map();
    this.next = 1;
  }

  keyFor(id, frame) {
    let key = this.byId.get(id);
    if (!key) {
      key = `f${this.next++}`;
      this.byId.set(id, key);
    }
    this.byKey.set(key, { ...(this.byKey.get(key) ?? {}), ...frame, id, key });
    return key;
  }

  get(key) {
    return this.byKey.get(key) ?? null;
  }
}

export function unknownFrame(frameKey, selector) {
  return {
    found: false,
    selector,
    error: `Unknown frame ${frameKey}: frame refs come from get_snapshot, and the frame may have gone; call get_snapshot again`,
  };
}

// A result from a frame names the selector the tool was given, with its
// frame, rather than the frame's own ref.
export function restoreFrameSelector(result, route, selector) {
  return result &&
    typeof result === "object" &&
    result.selector === route.selector
    ? { ...result, selector }
    : result;
}

// A change report from a frame, with its refs carrying the frame's key.
export function prefixFrameReport(report, frameKey) {
  if (!report || typeof report !== "object") {
    return report;
  }
  const prefix = (line) => line.replace(/^e(\d+)/, `${frameKey}e$1`);
  const lists = Object.fromEntries(
    ["added", "removed", "updated"]
      .filter((key) => report[key]?.lines)
      .map((key) => [
        key,
        { ...report[key], lines: report[key].lines.map(prefix) },
      ]),
  );
  return {
    ...report,
    ...lists,
    ...(Array.isArray(report.nodes) ? { nodes: report.nodes.map(prefix) } : {}),
  };
}

// Moves the points a page action in a frame reports into the top page's
// viewport.
export function shiftFramePoints(result, offset) {
  if (!result || typeof result !== "object" || !offset) {
    return result;
  }
  const shifted = { ...result };
  if (result.point) {
    shifted.point = {
      x: result.point.x + offset.x,
      y: result.point.y + offset.y,
    };
  }
  if (result.node?.box) {
    const box = result.node.box;
    shifted.node = {
      ...result.node,
      box: {
        ...box,
        x: box.x + offset.x,
        y: box.y + offset.y,
        left: box.left + offset.x,
        right: box.right + offset.x,
        top: box.top + offset.y,
        bottom: box.bottom + offset.y,
      },
    };
  }
  return shifted;
}

// A frame's snapshot lines, after a header naming the frame, with refs
// carrying the frame's key.
export function frameSnapshotLines(frameKey, frame, result) {
  const header =
    `${frameKey} frame ${JSON.stringify(result.title ?? "")} ${result.url ?? frame.url ?? ""}`.trim();
  const lines = (result.nodes ?? []).map((line) =>
    line.replace(/^e(\d+)/, `${frameKey}e$1`),
  );
  if (result.more > 0) {
    lines.push(`(${result.more} more nodes in ${frameKey})`);
  }
  return [header, ...lines];
}

// Adds the frames' snapshots to the top page's: each frame with nodes gets
// a header and its lines. A frame's refs number on from its own last
// snapshot, as the top page's do. Frames without a box are left out.
export async function addFrameSnapshots({
  result,
  frames,
  frameKeys,
  runInFrame,
  options,
}) {
  if (!result?.found || !Array.isArray(result.nodes)) {
    return result;
  }
  const nodes = [...result.nodes];
  let shown = 0;
  for (const frame of frames) {
    if (shown >= MAX_SNAPSHOT_FRAMES) {
      break;
    }
    const key = frameKeys.keyFor(frame.id, frame);
    const entry = frameKeys.get(key);
    let snapshot;
    try {
      snapshot = await runInFrame(
        key,
        {
          action: "snapshot",
          limit: options.limit,
          headings: options.headings,
          refStart: entry.refStart ?? 1,
        },
        { scroll: false },
      );
    } catch {
      continue;
    }
    if (!snapshot?.found) {
      continue;
    }
    snapshot = takeNextRef(entry, snapshot);
    if (snapshot.nodes.length === 0) {
      continue;
    }
    nodes.push(...frameSnapshotLines(key, frame, snapshot));
    shown += 1;
  }
  return { ...result, nodes };
}

// A snapshot of one element inside a frame, named by a frame ref.
export async function frameElementSnapshot({
  route,
  frameKeys,
  runInFrame,
  options,
}) {
  const entry = frameKeys.get(route.frameKey);
  if (!entry) {
    return unknownFrame(route.frameKey, options.selector);
  }
  const snapshot = await runInFrame(route.frameKey, {
    action: "snapshot",
    selector: route.selector,
    limit: options.limit,
    headings: options.headings,
    refStart: entry.refStart ?? 1,
  });
  if (!snapshot?.found) {
    return snapshot;
  }
  const { nodes, more, ...rest } = takeNextRef(entry, snapshot);
  return {
    ...rest,
    nodes: nodes.map((line) => line.replace(/^e(\d+)/, `${route.frameKey}e$1`)),
    more,
  };
}

// The scope a delivery probe was armed in: the frame of a frame ref, else
// the top document. Passed as the probe's selector, so it is read there.
export function probeScope(target) {
  return typeof target === "string" && parseFrameRef(target)
    ? { selector: target }
    : {};
}
