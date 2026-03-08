import {
  filterConsoleMessages,
  summarizeNetworkRequests,
} from "./session-events.mjs";
import { buildPageContextExpression } from "./page-context.mjs";

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

function cdpBrowserFamily(config) {
  return config.browserFamily === "edge" ? "edge" : "chromium";
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

export class CdpSession {
  constructor(target, options = {}) {
    this.id = crypto.randomUUID();
    this.target = target;
    this.eventBufferSize = options.eventBufferSize ?? 200;
    this.onClosed = options.onClosed ?? null;
    this.bufferedEvents = [];
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

    this.pushEvent({
      method,
      capturedAt,
      ...normalizeEvent(method, params),
    });
    this.resolveEventWaiters(method, params);
  }

  pushEvent(event) {
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

  async evaluate(expression, options = {}) {
    const result = await this.evaluateRuntime(expression, options);

    return {
      result: summarizeRemoteObject(result.result),
      exceptionDetails: result.exceptionDetails ?? null,
    };
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
      throw new Error(result.exceptionDetails.text || "Page action failed");
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

  async inspectElement(selector) {
    return this.runPageAction({
      action: "inspect",
      selector,
    });
  }

  async click(selector) {
    return this.runPageAction(
      {
        action: "click",
        selector,
      },
      { userGesture: true },
    );
  }

  async hover(selector) {
    return this.runPageAction(
      {
        action: "hover",
        selector,
      },
      { userGesture: true },
    );
  }

  async type(selector, text, options = {}) {
    return this.runPageAction(
      {
        action: "type",
        selector,
        text,
        clear: options.clear,
      },
      { userGesture: true },
    );
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
    return this.runPageAction(
      {
        action: "press_key",
        key,
        selector,
      },
      { userGesture: true },
    );
  }

  async scroll(options = {}) {
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
  }

  async fetchJson(pathname) {
    const url = new URL(pathname, `${this.config.cdpBaseUrl}/`);
    const response = await fetch(url);
    return parseJson(response);
  }

  async getBrowserStatus() {
    try {
      const info = await this.fetchJson("/json/version");
      return {
        available: true,
        endpoint: this.config.cdpBaseUrl,
        sessionCount: this.sessions.size,
        browser: info.Browser,
        protocolVersion: info["Protocol-Version"],
        userAgent: info["User-Agent"],
      };
    } catch (error) {
      return {
        available: false,
        endpoint: this.config.cdpBaseUrl,
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

  async attachToTarget(targetId) {
    const targets = await this.listTargets();
    const target = targets.find((candidate) => candidate.targetId === targetId);
    if (!target) {
      throw new Error(`No page target found for ${targetId}`);
    }

    const session = new CdpSession(target, {
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

  async evaluate(sessionId, expression, options) {
    return this.getSession(sessionId).evaluate(expression, options);
  }

  async getDocument(sessionId, depth) {
    return this.getSession(sessionId).getDocument(depth);
  }

  async getPageState(sessionId) {
    return this.getSession(sessionId).getPageState();
  }

  async navigate(sessionId, url, options) {
    return this.getSession(sessionId).navigate(url, options);
  }

  async reload(sessionId, options) {
    return this.getSession(sessionId).reload(options);
  }

  async click(sessionId, selector) {
    return this.getSession(sessionId).click(selector);
  }

  async hover(sessionId, selector) {
    return this.getSession(sessionId).hover(selector);
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

  async inspectElement(sessionId, selector) {
    return this.getSession(sessionId).inspectElement(selector);
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
