import {
  exportHarLikeSummary,
  filterConsoleMessages,
  InFlightRequests,
  summarizeNetworkRequests,
} from "./session-events.mjs";
import { DEFAULT_CDP_BASE_URL } from "./config.mjs";
import { waitForPageCondition } from "./wait-for.mjs";
import {
  assertEnabled,
  assertPointerTarget,
  buildInputRecorderExpression,
  buildPageContextExpression,
} from "./page-context.mjs";
import { buildCdpKeyEvents } from "./keyboard.mjs";
import { sendCheckedInput } from "./input-delivery.mjs";
import {
  takeFileTarget,
  assertFileInput,
  uploadResult,
  describePointer,
  dragEnd,
  wheelScroll,
  dragPath,
  pointerFields,
  takeNextRef,
} from "./page-context.mjs";

// How long a drag waits after its first move for the page to start an HTML5
// drag, and the longest a drag's interception stays open.
const DRAG_START_MS = 100;
// How long a click may take to open a file chooser.
const FILE_CHOOSER_MS = 2000;
const DRAG_SESSION_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTarget(target) {
  return {
    targetId: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: Boolean(target.attached),
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  };
}

function inferTitle(url) {
  if (!url) {
    return "New Tab";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function cdpBrowserFamily(config) {
  return config.browserFamily === "edge" ? "edge" : "chromium";
}

function buildDiscoveryBaseUrls(configuredBaseUrl) {
  const configured = new URL(configuredBaseUrl);
  const candidatePorts = [
    configured.port || "9222",
    "9223",
    "9224",
    "9225",
    "9226",
  ];
  const seen = new Set();
  const candidates = [];

  for (const port of candidatePorts) {
    const candidate = new URL(configured.toString());
    candidate.port = port;
    candidate.pathname = "/";
    candidate.search = "";
    candidate.hash = "";
    const normalized = candidate.toString().replace(/\/+$/, "");
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    candidates.push(normalized);
  }

  return candidates;
}

function summarizeRemoteObject(object) {
  if (!object) {
    return null;
  }

  if (object.value !== undefined) {
    return object.value;
  }

  if (object.description) {
    return object.description;
  }

  if (object.unserializableValue) {
    return object.unserializableValue;
  }

  return {
    type: object.type,
    subtype: object.subtype,
    className: object.className,
  };
}

function summarizeCallFrames(callFrames = []) {
  return callFrames.map((frame) => ({
    functionName: frame.functionName || null,
    url: frame.url || null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  }));
}

function firstCallFrame(stackTrace) {
  const frame = stackTrace?.callFrames?.[0];
  if (!frame) {
    return null;
  }

  return {
    functionName: frame.functionName || null,
    url: frame.url || null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  };
}

function normalizeConsoleText(values = []) {
  const text = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) =>
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    )
    .join(" ");

  return text || null;
}

function screenshotMimeType(format) {
  if (format === "jpeg") {
    return "image/jpeg";
  }

  if (format === "webp") {
    return "image/webp";
  }

  return "image/png";
}

function formatScreenshotResult(data, format, extras = {}) {
  return {
    format,
    mimeType: screenshotMimeType(format),
    encoding: "base64",
    byteLength: Buffer.byteLength(data, "base64"),
    data,
    ...extras,
  };
}

function normalizeWaitUntil(value) {
  if (value === "none" || value === "interactive") {
    return value;
  }

  return "complete";
}

function cdpLifecycleEventFor(waitUntil) {
  if (waitUntil === "interactive") {
    return "Page.domContentEventFired";
  }

  if (waitUntil === "none") {
    return null;
  }

  return "Page.loadEventFired";
}

function normalizeEvent(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    const values = (params.args || []).map(summarizeRemoteObject);
    const source = firstCallFrame(params.stackTrace);
    return {
      kind: "console",
      level: params.type,
      timestamp: params.timestamp,
      text: normalizeConsoleText(values),
      values,
      source,
      stackTrace: summarizeCallFrames(params.stackTrace?.callFrames),
    };
  }

  if (method === "Runtime.exceptionThrown") {
    const exception = params.exceptionDetails?.exception ?? null;
    return {
      kind: "exception",
      timestamp: params.timestamp,
      text: params.exceptionDetails?.text,
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
      stackTrace: summarizeCallFrames(
        params.exceptionDetails?.stackTrace?.callFrames,
      ),
      exception:
        exception && typeof exception === "object"
          ? summarizeRemoteObject(exception)
          : null,
    };
  }

  if (method === "Log.entryAdded") {
    const source = firstCallFrame(params.entry?.stackTrace);
    return {
      kind: "log",
      level: params.entry?.level,
      text: params.entry?.text,
      url: params.entry?.url,
      timestamp: params.entry?.timestamp,
      lineNumber: source?.lineNumber ?? null,
      columnNumber: source?.columnNumber ?? null,
      source,
      stackTrace: summarizeCallFrames(params.entry?.stackTrace?.callFrames),
    };
  }

  if (method === "Network.requestWillBeSent") {
    return {
      kind: "network",
      phase: "request",
      completed: false,
      timestamp: params.timestamp,
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      resourceType: params.type,
      source: "protocol",
    };
  }

  if (method === "Network.responseReceived") {
    return {
      kind: "network",
      phase: "response",
      completed: false,
      timestamp: params.timestamp,
      requestId: params.requestId,
      url: params.response?.url,
      resourceType: params.type,
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      source: "protocol",
    };
  }

  if (method === "Network.loadingFinished") {
    return {
      kind: "network",
      phase: "finished",
      completed: true,
      failed: false,
      timestamp: params.timestamp,
      requestId: params.requestId,
      encodedBodySize: params.encodedDataLength ?? null,
      source: "protocol",
    };
  }

  if (method === "Network.loadingFailed") {
    return {
      kind: "network",
      phase: "failed",
      completed: true,
      failed: true,
      timestamp: params.timestamp,
      requestId: params.requestId,
      errorText: params.errorText,
      canceled: params.canceled ?? false,
      source: "protocol",
    };
  }

  if (
    method === "Page.frameNavigated" ||
    method === "Page.navigatedWithinDocument"
  ) {
    return {
      kind: "page",
      phase: "navigated",
      timestamp: new Date().toISOString(),
      url: params.frame?.url ?? params.url ?? null,
      frameId: params.frame?.id ?? params.frameId ?? null,
      loaderId: params.frame?.loaderId ?? params.loaderId ?? null,
    };
  }

  if (
    method === "Page.loadEventFired" ||
    method === "Page.domContentEventFired" ||
    method === "Page.frameStoppedLoading"
  ) {
    return {
      kind: "page",
      phase: method,
      timestamp: params.timestamp ?? new Date().toISOString(),
    };
  }

  if (
    method === "Page.javascriptDialogOpening" ||
    method === "Page.javascriptDialogClosed"
  ) {
    return {
      kind: "dialog",
      phase: method === "Page.javascriptDialogOpening" ? "opened" : "closed",
      dialogType: params.type ?? null,
      message: params.message ?? null,
      defaultPrompt: params.defaultPrompt ?? null,
      url: params.url ?? null,
    };
  }

  return {
    kind: "raw",
    method,
    params,
  };
}

async function parseJson(response) {
  if (!response.ok) {
    throw new Error(
      `CDP endpoint returned ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

async function readWebSocketData(data) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }

  if (typeof data?.text === "function") {
    return data.text();
  }

  return String(data);
}

// CDP reports a thrown value as text "Uncaught". An error's message is on
// the first line of its description ("Error: message"); a thrown primitive
// is in value.
function pageExceptionMessage(details) {
  const exception = details.exception;
  const description = exception?.description;
  if (typeof description === "string" && description.trim()) {
    return description.split("\n")[0].replace(/^[A-Za-z]*Error: /, "");
  }
  if (exception && "value" in exception && exception.value !== undefined) {
    return String(exception.value);
  }
  return details.text || "Page action failed";
}

export class CdpSession {
  constructor(target, options = {}) {
    this.id = crypto.randomUUID();
    this.config = options.config ?? { browserFamily: "chromium" };
    this.target = target;
    this.eventBufferSize = options.eventBufferSize ?? 200;
    this.onClosed = options.onClosed ?? null;
    this.bufferedEvents = [];
    this.inFlight = new InFlightRequests();
    this.pending = new Map();
    this.nextMessageId = 1;
    this.connectedAt = new Date().toISOString();
    this.websocket = null;
    this.closed = false;
    this.eventWaiters = new Set();
    this.lastNavigationAt = null;
    this.lastReloadAt = null;
    this.viewportOverride = null;
  }

  markClosed() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectPending(new Error("CDP session closed"));
    this.rejectEventWaiters(new Error("CDP session closed"));
    this.onClosed?.(this);
  }

  async connect() {
    if (!this.target.webSocketDebuggerUrl) {
      throw new Error(
        `Target ${this.target.targetId} does not expose a debugger websocket`,
      );
    }

    this.websocket = new WebSocket(this.target.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      let settled = false;

      this.websocket.addEventListener(
        "open",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        },
        { once: true },
      );

      this.websocket.addEventListener(
        "error",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          reject(
            new Error(
              `Failed to connect to ${this.target.webSocketDebuggerUrl}`,
            ),
          );
        },
        { once: true },
      );

      this.websocket.addEventListener("close", () => {
        this.markClosed();
        if (!settled) {
          settled = true;
          reject(new Error(`Debugger websocket closed before it connected`));
        }
      });

      this.websocket.addEventListener("message", (event) => {
        void this.handleMessage(event.data);
      });
    });

    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("DOM.enable"),
      this.send("Log.enable"),
      this.send("Network.enable"),
    ]);

    await this.installInputRecorder();
    await this.seedBufferedState();

    return this.getSummary();
  }

  async handleMessage(data) {
    const raw = await readWebSocketData(data);
    const message = JSON.parse(raw);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${message.error.message} (code ${message.error.code})`),
        );
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (!message.method) {
      return;
    }

    this.bufferEvent(message.method, message.params ?? {});
  }

  bufferEvent(method, params) {
    const capturedAt = new Date().toISOString();
    if (
      method === "Page.frameNavigated" &&
      params.frame?.url &&
      !params.frame?.parentId
    ) {
      this.target.url = params.frame.url;
      this.lastNavigationAt = capturedAt;
    }

    if (method === "Page.navigatedWithinDocument" && params.url) {
      this.target.url = params.url;
      this.lastNavigationAt = capturedAt;
    }

    if (method === "Page.loadEventFired") {
      this.lastNavigationAt = capturedAt;
    }

    if (method === "Page.javascriptDialogOpening") {
      this.autoDismissDialog(params);
    }

    this.pushEvent({
      method,
      capturedAt,
      ...normalizeEvent(method, params),
    });
    this.resolveEventWaiters(method, params);
  }

  autoDismissDialog(params) {
    const accept = params.type !== "prompt";
    this.send("Page.handleJavaScriptDialog", { accept }).catch(() => {});
  }

  pushEvent(event) {
    this.inFlight.observe(event);
    this.bufferedEvents.push(event);
    if (this.bufferedEvents.length > this.eventBufferSize) {
      this.bufferedEvents.shift();
    }
  }

  resolveEventWaiters(method, params) {
    for (const waiter of Array.from(this.eventWaiters)) {
      if (waiter.method !== method) {
        continue;
      }

      try {
        if (!waiter.predicate(params)) {
          continue;
        }
      } catch {
        continue;
      }

      clearTimeout(waiter.timer);
      this.eventWaiters.delete(waiter);
      waiter.resolve(params);
    }
  }

  rejectEventWaiters(error) {
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }

    this.eventWaiters.clear();
  }

  createEventWaiter(method, predicate = () => true, timeoutMs = 10_000) {
    let waiter = null;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      waiter = { method, predicate, resolve, reject, timer };
      this.eventWaiters.add(waiter);
    });
    // Callers await the promise only after sending their command, so a
    // rejection before then (the tab closing, or a timeout) must not count as
    // unhandled; it still reaches the caller when it awaits.
    promise.catch(() => {});

    return {
      promise,
      cancel: (error = new Error(`Stopped waiting for ${method}`)) => {
        if (waiter && this.eventWaiters.delete(waiter)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      },
    };
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10_000) {
    return this.createEventWaiter(method, predicate, timeoutMs).promise;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP session ${this.id} is not connected`);
    }

    const id = this.nextMessageId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.websocket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluateRuntime(expression, options = {}) {
    return this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      replMode: options.replMode ?? true,
      userGesture: options.userGesture ?? false,
    });
  }

  // REPL mode allows top-level await but, like the DevTools console, returns
  // a promise the expression evaluates to without awaiting it. So evaluate by
  // reference, await a returned promise, and only then read the value.
  async evaluate(expression, options = {}) {
    const awaitPromise = options.awaitPromise ?? true;
    const returnByValue = options.returnByValue ?? true;
    let response = await this.evaluateRuntime(expression, {
      ...options,
      awaitPromise,
      returnByValue: false,
    });
    const objectIds = new Set();
    const hold = (reply) => {
      for (const objectId of [
        reply.result?.objectId,
        reply.exceptionDetails?.exception?.objectId,
      ]) {
        if (objectId) {
          objectIds.add(objectId);
        }
      }
    };
    hold(response);

    try {
      if (
        awaitPromise &&
        !response.exceptionDetails &&
        response.result?.subtype === "promise"
      ) {
        response = await this.send("Runtime.awaitPromise", {
          promiseObjectId: response.result.objectId,
          returnByValue,
        });
        hold(response);
      } else if (
        returnByValue &&
        !response.exceptionDetails &&
        response.result?.objectId &&
        response.result.type !== "symbol"
      ) {
        response = await this.send("Runtime.callFunctionOn", {
          functionDeclaration: "function () { return this; }",
          objectId: response.result.objectId,
          returnByValue: true,
        });
        hold(response);
      }

      // As on Firefox, a thrown error is reported only in exceptionDetails.
      return {
        result: response.exceptionDetails
          ? null
          : summarizeRemoteObject(response.result),
        exceptionDetails: response.exceptionDetails ?? null,
      };
    } finally {
      for (const objectId of objectIds) {
        this.send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
    }
  }

  async getDocument(depth = 2) {
    return this.send("DOM.getDocument", {
      depth,
      pierce: true,
    });
  }

  async runPageAction(payload, options = {}) {
    const result = await this.evaluateRuntime(
      buildPageContextExpression(
        {
          browserFamily: cdpBrowserFamily(this.config),
          ...payload,
        },
        { serialize: true },
      ),
      {
        awaitPromise: true,
        replMode: false,
        userGesture: options.userGesture ?? false,
      },
    );

    if (result.exceptionDetails) {
      throw new Error(pageExceptionMessage(result.exceptionDetails));
    }

    const value = result.result?.value ?? summarizeRemoteObject(result.result);
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async getPageState() {
    const result = await this.runPageAction({
      action: "page_state",
    });

    return {
      browserFamily: cdpBrowserFamily(this.config),
      ...result.page,
      lastNavigationAt: this.lastNavigationAt,
      lastReloadAt: this.lastReloadAt,
      viewportOverride: this.viewportOverride,
    };
  }

  async takeScreenshot(format = "png", options = {}) {
    if (options.selector) {
      const inspected = await this.runPageAction({
        action: "inspect",
        selector: options.selector,
        scrollIntoView: true,
      });

      if (!inspected.found) {
        return {
          browserFamily: cdpBrowserFamily(this.config),
          format,
          scope: "element",
          selector: options.selector,
          found: false,
        };
      }

      const clip = {
        x: Math.max(inspected.node.box?.x ?? 0, 0),
        y: Math.max(inspected.node.box?.y ?? 0, 0),
        width: Math.max(inspected.node.box?.width ?? 0, 1),
        height: Math.max(inspected.node.box?.height ?? 0, 1),
        scale: 1,
      };

      const screenshot = await this.send("Page.captureScreenshot", {
        format,
        clip,
      });

      return formatScreenshotResult(screenshot.data, format, {
        browserFamily: cdpBrowserFamily(this.config),
        scope: "element",
        selector: options.selector,
        clip,
      });
    }

    const screenshot = await this.send("Page.captureScreenshot", { format });
    return formatScreenshotResult(screenshot.data, format, {
      browserFamily: cdpBrowserFamily(this.config),
      scope: "page",
    });
  }

  getConsoleMessages(limit = 50) {
    return filterConsoleMessages(this.bufferedEvents, limit);
  }

  getNetworkRequests(limit = 50) {
    return summarizeNetworkRequests(this.bufferedEvents, limit);
  }

  async getCookies() {
    return this.runPageAction({
      action: "cookie_snapshot",
    });
  }

  async getStorage() {
    return this.runPageAction({
      action: "storage_snapshot",
    });
  }

  async captureDebugReport(options = {}) {
    const consoleLimit =
      Number.isInteger(options.consoleLimit) && options.consoleLimit > 0
        ? options.consoleLimit
        : 20;
    const networkLimit =
      Number.isInteger(options.networkLimit) && options.networkLimit > 0
        ? options.networkLimit
        : 20;
    const includeScreenshot = options.includeScreenshot !== false;
    const screenshotFormat = options.screenshotFormat ?? "png";
    const snapshot = await this.runPageAction({
      action: "debug_report",
    });

    return {
      browserFamily: cdpBrowserFamily(this.config),
      capturedAt: new Date().toISOString(),
      page: {
        ...(await this.getPageState()),
      },
      cookies: snapshot.cookies,
      storage: snapshot.storage,
      console: this.getConsoleMessages(consoleLimit),
      network: this.getNetworkRequests(networkLimit),
      screenshot: includeScreenshot
        ? await this.takeScreenshot(screenshotFormat)
        : null,
    };
  }

  getHar(options = {}) {
    return exportHarLikeSummary(this.bufferedEvents, {
      limit: options.limit ?? 50,
      page: {
        title: this.target.title,
        url: this.target.url,
      },
    });
  }

  async captureSessionSnapshot() {
    return {
      browserFamily: cdpBrowserFamily(this.config),
      capturedAt: new Date().toISOString(),
      page: await this.getPageState(),
      ...(await this.getCookies()),
      ...(await this.getStorage()),
    };
  }

  async restoreSessionSnapshot(snapshot, options = {}) {
    const result = await this.runPageAction({
      action: "restore_snapshot",
      snapshot,
      clearStorage: options.clearStorage === true,
    });

    return {
      ...result,
      page: await this.getPageState(),
    };
  }

  // Refs number on from the last snapshot, across navigations, so an old
  // ref never names an element on a later page.
  async runSnapshotAction(payload) {
    const result = await this.runPageAction({
      ...payload,
      refStart: this.refStart ?? 1,
    });
    return takeNextRef(this, result);
  }

  async snapshotControls() {
    return this.runSnapshotAction({ action: "controls_snapshot" });
  }

  async snapshotPage(options = {}) {
    return this.runSnapshotAction({ action: "snapshot", ...options });
  }

  async trackChanges(phase, options = {}) {
    return this.runSnapshotAction({ action: `change_${phase}`, ...options });
  }

  async readText(options = {}) {
    return this.runPageAction({ action: "read_text", ...options });
  }

  async inspectElement(selector, options = {}) {
    return this.runPageAction({
      action: "inspect",
      selector,
      textChecks: options.textChecks,
    });
  }

  async resolvePointerTarget(selector, options = {}) {
    const target = await this.runPageAction({
      action: "pointer_target",
      selector,
      ...(options.inputProbe ? { inputProbe: options.inputProbe } : {}),
      ...(options.scrollIntoView === false ? { scrollIntoView: false } : {}),
    });
    assertPointerTarget(target);
    return target;
  }

  // A locator, scrolled into view unless scrollIntoView is false, or
  // viewport coordinates, which never scroll.
  async resolvePointer(target, options = {}) {
    if (typeof target === "string") {
      return this.resolvePointerTarget(target, options);
    }
    return this.runSnapshotAction({
      action: "point_target",
      x: target.x,
      y: target.y,
      ...(options.inputProbe ? { inputProbe: options.inputProbe } : {}),
    });
  }

  async readInputProbe(token, disarm) {
    try {
      const probe = await this.runPageAction({
        action: "input_probe",
        token,
        disarm,
      });
      return probe.armed ? probe : null;
    } catch {
      return null;
    }
  }

  // A double click is two presses, the second with clickCount 2, as the
  // browser reports them.
  async dispatchClick(point, options = {}) {
    const button = options.button ?? "left";
    const buttons = { left: 1, right: 2, middle: 4 }[button] ?? 1;
    await this.dispatchMouse("mouseMoved", point);
    for (let count = 1; count <= (options.clickCount ?? 1); count += 1) {
      const press = { button, clickCount: count };
      await this.dispatchMouse("mousePressed", point, { ...press, buttons });
      await this.dispatchMouse("mouseReleased", point, {
        ...press,
        buttons: 0,
      });
    }
  }

  async dispatchMouse(type, point, extra = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      ...extra,
    });
  }

  async dispatchKeyEvents(events) {
    for (const params of events) {
      await this.send("Input.dispatchKeyEvent", params);
    }
  }

  async click(target, options = {}) {
    const token = crypto.randomUUID();
    const resolved = await this.resolvePointer(target, { inputProbe: token });
    if (!resolved.found) {
      return resolved;
    }
    if (typeof target === "string") {
      assertEnabled(resolved);
    }

    const delivery = await sendCheckedInput({
      send: () => this.dispatchClick(resolved.point, options),
      readProbe: (disarm) => this.readInputProbe(token, disarm),
      recover: () => this.bringToFront(),
      describe: `The click on ${describePointer(target)}`,
    });

    return {
      browserFamily: cdpBrowserFamily(this.config),
      found: true,
      clicked: true,
      ...(delivery.resent ? { resent: true } : {}),
      ...pointerFields(target, resolved, delivery.node ?? resolved.node),
    };
  }

  // Bringing the tab to the front makes Chrome render it again, which is
  // the one recovery tried before resending input the page never received.
  async bringToFront() {
    await this.send("Page.bringToFront").catch(() => {});
  }

  async hover(target) {
    const resolved = await this.resolvePointer(target);
    if (!resolved.found) {
      return resolved;
    }

    await this.dispatchMouse("mouseMoved", resolved.point);

    return {
      browserFamily: cdpBrowserFamily(this.config),
      found: true,
      hovered: true,
      ...pointerFields(target, resolved),
    };
  }

  // Presses at from, moves through dragPath, and releases at to. Chrome
  // does not run an HTML5 drag (draggable elements, dataTransfer) from CDP
  // mouse input, so drags are intercepted: when the page starts one, Chrome
  // hands over its data and the drag finishes with drag events instead.
  async drag(from, to, options = {}) {
    const token = crypto.randomUUID();
    const source = await this.resolvePointer(from, { inputProbe: token });
    if (!source.found) {
      await this.readInputProbe(token, true);
      return source;
    }
    // The drop point is read without scrolling, so the source stays put.
    const target = await this.resolvePointer(to, { scrollIntoView: false });
    if (!target.found) {
      await this.readInputProbe(token, true);
      return target;
    }

    await this.send("Input.setInterceptDrags", { enabled: true });
    let dragData = null;
    const intercepted = this.createEventWaiter(
      "Input.dragIntercepted",
      () => true,
      DRAG_SESSION_MS,
    );
    intercepted.promise.then(
      (params) => {
        dragData = params.data;
      },
      () => {},
    );
    const held = { button: "left", buttons: 1 };
    const release = { button: "left", buttons: 0, clickCount: 1 };
    let delivery;
    let released = false;
    try {
      delivery = await sendCheckedInput({
        send: async () => {
          await this.dispatchMouse("mouseMoved", source.point);
          await this.dispatchMouse("mousePressed", source.point, {
            ...held,
            clickCount: 1,
          });
        },
        readProbe: (disarm) => this.readInputProbe(token, disarm),
        recover: () => this.bringToFront(),
        describe: `The press to drag ${describePointer(from)}`,
      });

      const path = dragPath(source.point, target.point, options.steps);
      let index = 0;
      for (; index < path.length && !dragData; index += 1) {
        await this.dispatchMouse("mouseMoved", path[index], held);
        if (index === 0) {
          // A page starts an HTML5 drag on the first move past a few pixels.
          await Promise.race([intercepted.promise, sleep(DRAG_START_MS)]).catch(
            () => {},
          );
        }
      }
      if (dragData) {
        const rest = path.slice(index);
        const enter = rest[0] ?? target.point;
        await this.dispatchDrag("dragEnter", enter, dragData);
        for (const point of rest) {
          await this.dispatchDrag("dragOver", point, dragData);
        }
        await this.dispatchDrag("drop", target.point, dragData);
      }
      await this.dispatchMouse("mouseReleased", target.point, release);
      released = true;
    } finally {
      // A drag that failed partway must not leave the button down for the
      // next action.
      if (!released) {
        if (dragData) {
          await this.dispatchDrag("dragCancel", target.point, dragData).catch(
            () => {},
          );
        }
        await this.dispatchMouse("mouseReleased", target.point, release).catch(
          () => {},
        );
      }
      intercepted.cancel();
      await this.send("Input.setInterceptDrags", { enabled: false }).catch(
        () => {},
      );
    }

    return {
      browserFamily: cdpBrowserFamily(this.config),
      found: true,
      dragged: true,
      html5: Boolean(dragData),
      ...(delivery.resent ? { resent: true } : {}),
      from: dragEnd(from, source),
      to: dragEnd(to, target),
    };
  }

  async dispatchDrag(type, point, data) {
    await this.send("Input.dispatchDragEvent", {
      type,
      x: point.x,
      y: point.y,
      data,
    });
  }

  async type(selector, text, options = {}) {
    const token = crypto.randomUUID();
    const prepared = await this.runPageAction(
      {
        action: "prepare_type",
        selector,
        text,
        clear: options.clear,
        inputProbe: token,
      },
      { userGesture: true },
    );
    if (!prepared.found || prepared.method !== "native") {
      return prepared;
    }

    // insertText goes through the browser's editing pipeline, so frameworks
    // see trusted beforeinput/input events and the real value change.
    // Newlines become Enter presses, matching the Firefox path: a line break
    // in a textarea, implicit submission in a single-line input.
    const sendText = async () => {
      if (text) {
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        for (const [index, line] of lines.entries()) {
          if (index > 0) {
            await this.dispatchKeyEvents(buildCdpKeyEvents("Enter"));
          }
          if (line) {
            await this.send("Input.insertText", { text: line });
          }
        }
      } else if (options.clear !== false) {
        await this.dispatchKeyEvents(buildCdpKeyEvents("Delete"));
      }
    };

    let delivery = { node: null, resent: false };
    if (text || options.clear !== false) {
      delivery = await sendCheckedInput({
        send: sendText,
        readProbe: (disarm) => this.readInputProbe(token, disarm),
        recover: () => this.bringToFront(),
        describe: `The text for "${selector}"`,
      });
    } else {
      await this.readInputProbe(token, true);
    }

    let node = delivery.node;
    if (!node) {
      const typed = await this.runPageAction({
        action: "inspect",
        selector,
        scrollIntoView: false,
      });
      node = typed.found ? typed.node : prepared.node;
    }

    return {
      browserFamily: cdpBrowserFamily(this.config),
      selector,
      found: true,
      typedText: text,
      ...(delivery.resent ? { resent: true } : {}),
      node,
    };
  }

  // Sets files on a file input, or, for a button that opens a file chooser
  // from script, intercepts the chooser its click opens.
  async uploadFiles(selector, files) {
    const token = crypto.randomUUID();
    const target = await this.runPageAction({
      action: "file_input",
      selector,
      token,
      clear: files.length === 0,
    });
    if (!target.found) {
      return target;
    }
    const family = cdpBrowserFamily(this.config);
    if (target.cleared) {
      return uploadResult(family, selector, files);
    }
    if (target.fileInput) {
      const handle = await this.send("Runtime.evaluate", {
        expression: takeFileTarget(token),
        returnByValue: false,
      });
      const objectId = handle.result?.objectId;
      try {
        assertFileInput(target, files);
        await this.send("DOM.setFileInputFiles", { files, objectId });
      } finally {
        this.send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
      return uploadResult(family, selector, files, {
        multiple: target.multiple,
        accept: target.accept,
      });
    }

    // One chooser at a time per tab, so a chooser goes to the upload whose
    // click opened it.
    const previous = this.chooserTurn ?? Promise.resolve();
    let finished;
    this.chooserTurn = new Promise((resolve) => {
      finished = resolve;
    });
    await previous;
    try {
      return await this.uploadThroughChooser(selector, files, family);
    } finally {
      finished();
    }
  }

  async uploadThroughChooser(selector, files, family) {
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
    const chooser = this.createEventWaiter(
      "Page.fileChooserOpened",
      () => true,
      FILE_CHOOSER_MS,
    );
    try {
      await this.click(selector);
      let opened;
      try {
        opened = await chooser.promise;
      } catch {
        throw new Error(
          `"${selector}" is not a file input, and clicking it opened no file chooser; pass the <input type="file">, which may be hidden`,
        );
      }
      if (files.length > 1 && opened.mode !== "selectMultiple") {
        throw new Error(
          `The file chooser "${selector}" opened takes one file, not ${files.length}`,
        );
      }
      await this.send("DOM.setFileInputFiles", {
        files,
        backendNodeId: opened.backendNodeId,
      });
    } finally {
      chooser.cancel();
      await this.send("Page.setInterceptFileChooserDialog", {
        enabled: false,
      }).catch(() => {});
    }
    return uploadResult(family, selector, files, { chooser: true });
  }

  async select(selector, options = {}) {
    return this.runPageAction(
      {
        action: "select",
        selector,
        value: options.value,
        label: options.label,
      },
      { userGesture: true },
    );
  }

  async pressKey(key, selector = null) {
    const events = buildCdpKeyEvents(key);
    const token = crypto.randomUUID();
    const focused = await this.runPageAction(
      {
        action: "focus",
        selector,
        inputProbe: token,
      },
      { userGesture: true },
    );
    if (!focused.found) {
      return focused;
    }

    const delivery = await sendCheckedInput({
      send: () => this.dispatchKeyEvents(events),
      readProbe: (disarm) => this.readInputProbe(token, disarm),
      recover: () => this.bringToFront(),
      describe: `The key press "${key}"`,
    });

    return {
      browserFamily: cdpBrowserFamily(this.config),
      key,
      dispatched: true,
      ...(delivery.resent ? { resent: true } : {}),
      target: focused.target,
    };
  }

  // A selector alone scrolls its element into view and deltas alone scroll
  // the page. Coordinates, or a selector with deltas, send a real mouse
  // wheel there, which scrolls whatever is under the pointer, such as a list
  // inside the page.
  async scroll(options = {}) {
    if (wheelScroll(options)) {
      const target = options.selector ?? { x: options.x, y: options.y };
      const resolved = await this.resolvePointer(target);
      if (!resolved.found) {
        return resolved;
      }
      await this.dispatchMouse("mouseWheel", resolved.point, {
        deltaX: options.deltaX ?? 0,
        deltaY: options.deltaY ?? 0,
      });
      return {
        browserFamily: cdpBrowserFamily(this.config),
        found: true,
        scrolled: true,
        wheel: { deltaX: options.deltaX ?? 0, deltaY: options.deltaY ?? 0 },
        ...pointerFields(target, resolved),
      };
    }
    return this.runPageAction(
      {
        action: "scroll",
        selector: options.selector,
        deltaX: options.deltaX,
        deltaY: options.deltaY,
        block: options.block,
      },
      { userGesture: true },
    );
  }

  async navigate(url, options = {}) {
    const waitUntil = normalizeWaitUntil(options.waitUntil);
    const initiatedAt = new Date().toISOString();
    const lifecycleEvent = cdpLifecycleEventFor(waitUntil);
    const lifecycleWaiter = lifecycleEvent
      ? this.createEventWaiter(lifecycleEvent, () => true, options.timeoutMs)
      : null;

    try {
      const result = await this.send("Page.navigate", { url });
      if (result.errorText) {
        throw new Error(result.errorText);
      }

      this.target.url = url;
      if (lifecycleWaiter) {
        await lifecycleWaiter.promise;
      }

      const page = lifecycleWaiter ? await this.getPageState() : null;
      return {
        browserFamily: cdpBrowserFamily(this.config),
        url,
        frameId: result.frameId ?? null,
        loaderId: result.loaderId ?? null,
        waitUntil,
        initiatedAt,
        page,
      };
    } catch (error) {
      lifecycleWaiter?.cancel(error);
      throw error;
    }
  }

  async reload(options = {}) {
    const waitUntil = normalizeWaitUntil(options.waitUntil);
    const reloadedAt = new Date().toISOString();
    const lifecycleEvent = cdpLifecycleEventFor(waitUntil);
    const lifecycleWaiter = lifecycleEvent
      ? this.createEventWaiter(lifecycleEvent, () => true, options.timeoutMs)
      : null;

    try {
      await this.send("Page.reload", {
        ignoreCache: options.ignoreCache ?? false,
      });

      if (lifecycleWaiter) {
        await lifecycleWaiter.promise;
      }
    } catch (error) {
      lifecycleWaiter?.cancel(error);
      throw error;
    }

    this.lastReloadAt = reloadedAt;
    const page = lifecycleWaiter ? await this.getPageState() : null;
    return {
      browserFamily: cdpBrowserFamily(this.config),
      url: this.target.url,
      waitUntil,
      ignoreCache: options.ignoreCache ?? false,
      reloadedAt,
      page,
    };
  }

  async setViewport(options) {
    const viewport = {
      width: options.width,
      height: options.height,
      deviceScaleFactor:
        typeof options.deviceScaleFactor === "number" &&
        options.deviceScaleFactor > 0
          ? options.deviceScaleFactor
          : 1,
      mobile: options.mobile ?? false,
    };

    await this.send("Emulation.setDeviceMetricsOverride", viewport);
    this.viewportOverride = {
      ...viewport,
      appliedAt: new Date().toISOString(),
    };

    return {
      browserFamily: cdpBrowserFamily(this.config),
      applied: true,
      viewport: this.viewportOverride,
      page: await this.getPageState(),
    };
  }

  // Counts trusted input from the start of every later document, and from
  // now on in the current one, so input actions can check that their input
  // arrived. Without it they are reported as sent, unchecked.
  async installInputRecorder() {
    try {
      await this.send("Page.addScriptToEvaluateOnNewDocument", {
        source: buildInputRecorderExpression(true),
      });
      await this.evaluateRuntime(buildInputRecorderExpression(false), {
        awaitPromise: false,
        replMode: false,
      });
    } catch {
      // Ignore recorder failures so attach still succeeds.
    }
  }

  async seedBufferedState() {
    try {
      const snapshot = await this.runPageAction({
        action: "network_snapshot",
      });

      for (const entry of snapshot?.entries ?? []) {
        this.pushEvent({
          method: "Network.snapshotCaptured",
          capturedAt: new Date().toISOString(),
          kind: "network",
          phase: "snapshot",
          completed: true,
          finished: true,
          failed: false,
          canceled: false,
          source: "performance",
          ...entry,
        });
      }
    } catch {
      // Ignore snapshot failures so attach still succeeds against restrictive pages.
    }
  }

  getEvents(limit = 50) {
    const safeLimit = Math.max(1, limit);
    return this.bufferedEvents.slice(-safeLimit);
  }

  pendingRequests() {
    return this.inFlight.list();
  }

  getSummary() {
    return {
      sessionId: this.id,
      targetId: this.target.targetId,
      title: this.target.title,
      url: this.target.url,
      browserFamily: cdpBrowserFamily(this.config),
      connectedAt: this.connectedAt,
      bufferedEvents: this.bufferedEvents.length,
      lastNavigationAt: this.lastNavigationAt,
      lastReloadAt: this.lastReloadAt,
      viewportOverride: this.viewportOverride,
    };
  }

  async close() {
    if (!this.websocket || this.websocket.readyState >= WebSocket.CLOSING) {
      this.markClosed();
      return;
    }

    this.websocket.close();
  }
}

export class CdpSessionManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.resolvedBaseUrl = null;
    this.lastAttemptedBaseUrl = null;
    this.lastKnownBaseUrl = null;
    this.failedBaseUrlCooldownMs = 5_000;
    this.failedBaseUrlDeadlines = new Map();
    this.fetchTimeoutMs = 1_000;
  }

  shouldAutoDiscoverBaseUrl() {
    return this.config.cdpBaseUrl === DEFAULT_CDP_BASE_URL;
  }

  markBaseUrlFailed(baseUrl) {
    this.failedBaseUrlDeadlines.set(
      baseUrl,
      Date.now() + this.failedBaseUrlCooldownMs,
    );
  }

  invalidateBaseUrl(baseUrl) {
    this.markBaseUrlFailed(baseUrl);

    if (this.resolvedBaseUrl === baseUrl) {
      this.resolvedBaseUrl = null;
    }

    if (this.lastKnownBaseUrl === baseUrl) {
      this.lastKnownBaseUrl = null;
    }
  }

  pruneFailedBaseUrls(now = Date.now()) {
    for (const [baseUrl, deadline] of this.failedBaseUrlDeadlines.entries()) {
      if (deadline <= now) {
        this.failedBaseUrlDeadlines.delete(baseUrl);
      }
    }
  }

  async fetchJsonAt(baseUrl, pathname) {
    this.lastAttemptedBaseUrl = baseUrl;
    const url = new URL(pathname, `${baseUrl}/`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });
    return parseJson(response);
  }

  async resolveBaseUrl(excludedBaseUrls = new Set()) {
    if (this.resolvedBaseUrl) {
      return this.resolvedBaseUrl;
    }

    const candidates = this.shouldAutoDiscoverBaseUrl()
      ? buildDiscoveryBaseUrls(this.config.cdpBaseUrl)
      : [this.config.cdpBaseUrl];
    this.pruneFailedBaseUrls();
    const preferredCandidates = candidates.filter(
      (candidate) =>
        !excludedBaseUrls.has(candidate) &&
        !this.failedBaseUrlDeadlines.has(candidate),
    );
    const probeCandidates =
      preferredCandidates.length > 0
        ? preferredCandidates
        : candidates.filter((candidate) => !excludedBaseUrls.has(candidate));
    let lastError = null;

    for (const candidate of probeCandidates) {
      try {
        const info = await this.fetchJsonAt(candidate, "/json/version");
        if (!info.webSocketDebuggerUrl) {
          this.invalidateBaseUrl(candidate);
          continue;
        }

        this.failedBaseUrlDeadlines.delete(candidate);
        this.resolvedBaseUrl = candidate;
        this.lastKnownBaseUrl = candidate;
        return candidate;
      } catch (error) {
        this.invalidateBaseUrl(candidate);
        lastError = error;
      }
    }

    throw lastError ?? new Error("Unable to resolve a CDP browser endpoint");
  }

  async fetchJson(pathname) {
    const baseUrl = await this.resolveBaseUrl();

    try {
      return await this.fetchJsonAt(baseUrl, pathname);
    } catch (error) {
      if (!this.shouldAutoDiscoverBaseUrl() || !this.resolvedBaseUrl) {
        throw error;
      }

      this.invalidateBaseUrl(baseUrl);
      const rediscoveredBaseUrl = await this.resolveBaseUrl(new Set([baseUrl]));
      try {
        return await this.fetchJsonAt(rediscoveredBaseUrl, pathname);
      } catch (rediscoveredError) {
        this.invalidateBaseUrl(rediscoveredBaseUrl);
        throw rediscoveredError;
      }
    }
  }

  async sendBrowserCommand(method, params = {}) {
    const info = await this.fetchJson("/json/version");
    if (!info.webSocketDebuggerUrl) {
      throw new Error("Browser endpoint does not expose a debugger websocket");
    }

    const websocket = new WebSocket(info.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        websocket.removeEventListener("open", handleOpen);
        websocket.removeEventListener("message", handleMessage);
        websocket.removeEventListener("error", handleError);
        websocket.removeEventListener("close", handleClose);
      };

      const finish = (callback) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        callback();

        if (websocket.readyState < WebSocket.CLOSING) {
          websocket.close();
        }
      };

      const handleOpen = () => {
        try {
          websocket.send(
            JSON.stringify({
              id: 1,
              method,
              params,
            }),
          );
        } catch (error) {
          finish(() => reject(error));
        }
      };

      const handleMessage = async (event) => {
        const raw = await readWebSocketData(event.data);
        const message = JSON.parse(raw);
        if (message.id !== 1) {
          return;
        }

        if (message.error) {
          finish(() =>
            reject(
              new Error(
                `${message.error.message} (code ${message.error.code})`,
              ),
            ),
          );
          return;
        }

        finish(() => resolve(message.result ?? {}));
      };

      const handleError = () => {
        finish(() =>
          reject(
            new Error(`Failed to connect to ${info.webSocketDebuggerUrl}`),
          ),
        );
      };

      const handleClose = () => {
        finish(() => reject(new Error("Browser debugger websocket closed")));
      };

      websocket.addEventListener("open", handleOpen, { once: true });
      websocket.addEventListener("message", handleMessage);
      websocket.addEventListener("error", handleError, { once: true });
      websocket.addEventListener("close", handleClose, { once: true });
    }).catch((error) => {
      if (this.shouldAutoDiscoverBaseUrl() && this.resolvedBaseUrl) {
        this.invalidateBaseUrl(this.resolvedBaseUrl);
      }

      throw error;
    });
  }

  async getBrowserStatus() {
    try {
      const info = await this.fetchJson("/json/version");
      return {
        available: true,
        endpoint:
          this.resolvedBaseUrl ??
          this.lastKnownBaseUrl ??
          this.config.cdpBaseUrl,
        attemptedEndpoint:
          this.lastAttemptedBaseUrl ??
          this.resolvedBaseUrl ??
          this.lastKnownBaseUrl ??
          this.config.cdpBaseUrl,
        sessionCount: this.sessions.size,
        browser: info.Browser,
        protocolVersion: info["Protocol-Version"],
        userAgent: info["User-Agent"],
      };
    } catch (error) {
      return {
        available: false,
        endpoint:
          this.resolvedBaseUrl ??
          this.lastKnownBaseUrl ??
          this.config.cdpBaseUrl,
        attemptedEndpoint:
          this.lastAttemptedBaseUrl ??
          this.resolvedBaseUrl ??
          this.lastKnownBaseUrl ??
          this.config.cdpBaseUrl,
        sessionCount: this.sessions.size,
        error: toErrorMessage(error),
      };
    }
  }

  async listTargets() {
    const targets = await this.fetchJson("/json/list");
    return targets
      .filter((target) => target.type === "page")
      .map(normalizeTarget);
  }

  listSessions() {
    return Array.from(this.sessions.values(), (session) =>
      session.getSummary(),
    );
  }

  async createTab(url = "about:blank") {
    const targetUrl =
      typeof url === "string" && url.trim() ? url.trim() : "about:blank";
    const result = await this.sendBrowserCommand("Target.createTarget", {
      url: targetUrl,
    });
    const targetId = result.targetId;
    if (!targetId) {
      throw new Error("Browser did not return a target id for the new tab");
    }
    const target = (await this.listTargets()).find(
      (candidate) => candidate.targetId === targetId,
    );

    return {
      browserFamily: cdpBrowserFamily(this.config),
      ...(target ?? {
        targetId,
        type: "page",
        title: inferTitle(targetUrl),
        url: targetUrl,
        attached: false,
        webSocketDebuggerUrl: null,
      }),
    };
  }

  async attachToTarget(targetId) {
    const targets = await this.listTargets();
    const target = targets.find((candidate) => candidate.targetId === targetId);
    if (!target) {
      throw new Error(`No page target found for ${targetId}`);
    }

    const session = new CdpSession(target, {
      config: this.config,
      eventBufferSize: this.config.eventBufferSize,
      onClosed: (closedSession) => {
        this.sessions.delete(closedSession.id);
      },
    });
    await session.connect();
    this.sessions.set(session.id, session);
    return session.getSummary();
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No active session found for ${sessionId}`);
    }

    return session;
  }

  async detachSession(sessionId) {
    const session = this.getSession(sessionId);
    await session.close();
    this.sessions.delete(sessionId);
    return {
      detached: true,
      sessionId,
    };
  }

  async closeTarget(targetId) {
    const result = await this.sendBrowserCommand("Target.closeTarget", {
      targetId,
    });
    if (result.success === false) {
      throw new Error(`Failed to close target ${targetId}`);
    }

    const detachedSessions = Array.from(this.sessions.values())
      .filter((session) => session.target.targetId === targetId)
      .map((session) => {
        session.markClosed?.();
        this.sessions.delete(session.id);
        return { sessionId: session.id };
      });

    return {
      browserFamily: cdpBrowserFamily(this.config),
      closed: true,
      targetId,
      detachedSessions,
    };
  }

  async evaluate(sessionId, expression, options) {
    return this.getSession(sessionId).evaluate(expression, options);
  }

  async getDocument(sessionId, depth) {
    return this.getSession(sessionId).getDocument(depth);
  }

  async getPageState(sessionId) {
    return this.getSession(sessionId).getPageState();
  }

  async waitFor(sessionId, options = {}) {
    return waitForPageCondition({
      getPageState: () => this.getPageState(sessionId),
      inspectElement: (selector, options) =>
        this.inspectElement(sessionId, selector, options),
      evaluate: (expression) => this.evaluate(sessionId, expression),
      options,
    });
  }

  async navigate(sessionId, url, options) {
    return this.getSession(sessionId).navigate(url, options);
  }

  async reload(sessionId, options) {
    return this.getSession(sessionId).reload(options);
  }

  async click(sessionId, target, options) {
    return this.getSession(sessionId).click(target, options);
  }

  async hover(sessionId, target) {
    return this.getSession(sessionId).hover(target);
  }

  async drag(sessionId, from, to, options) {
    return this.getSession(sessionId).drag(from, to, options);
  }

  async uploadFiles(sessionId, selector, files) {
    return this.getSession(sessionId).uploadFiles(selector, files);
  }

  async type(sessionId, selector, text, options) {
    return this.getSession(sessionId).type(selector, text, options);
  }

  async select(sessionId, selector, options) {
    return this.getSession(sessionId).select(selector, options);
  }

  async pressKey(sessionId, key, selector) {
    return this.getSession(sessionId).pressKey(key, selector);
  }

  async scroll(sessionId, options) {
    return this.getSession(sessionId).scroll(options);
  }

  async setViewport(sessionId, options) {
    return this.getSession(sessionId).setViewport(options);
  }

  async takeScreenshot(sessionId, format, options = {}) {
    return this.getSession(sessionId).takeScreenshot(format, options);
  }

  getConsoleMessages(sessionId, limit) {
    return this.getSession(sessionId).getConsoleMessages(limit);
  }

  getNetworkRequests(sessionId, limit) {
    return this.getSession(sessionId).getNetworkRequests(limit);
  }

  async getCookies(sessionId) {
    return this.getSession(sessionId).getCookies();
  }

  async getStorage(sessionId) {
    return this.getSession(sessionId).getStorage();
  }

  async captureDebugReport(sessionId, options = {}) {
    return this.getSession(sessionId).captureDebugReport(options);
  }

  getHar(sessionId, options = {}) {
    return this.getSession(sessionId).getHar(options);
  }

  async captureSessionSnapshot(sessionId) {
    return this.getSession(sessionId).captureSessionSnapshot();
  }

  async restoreSessionSnapshot(sessionId, snapshot, options = {}) {
    return this.getSession(sessionId).restoreSessionSnapshot(snapshot, options);
  }

  async readText(sessionId, options) {
    return this.getSession(sessionId).readText(options);
  }

  async snapshotControls(sessionId) {
    return this.getSession(sessionId).snapshotControls();
  }

  async snapshotPage(sessionId, options) {
    return this.getSession(sessionId).snapshotPage(options);
  }

  async trackChanges(sessionId, phase, options) {
    return this.getSession(sessionId).trackChanges(phase, options);
  }

  async inspectElement(sessionId, selector, options) {
    return this.getSession(sessionId).inspectElement(selector, options);
  }

  pendingRequests(sessionId) {
    return this.getSession(sessionId).pendingRequests();
  }

  getEvents(sessionId, limit) {
    return this.getSession(sessionId).getEvents(limit);
  }

  async closeAll() {
    await Promise.allSettled(
      Array.from(this.sessions.values(), (session) => session.close()),
    );
    this.sessions.clear();
  }
}
