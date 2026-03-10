import {
  filterConsoleMessages,
  summarizeNetworkRequests,
} from "./session-events.mjs";
import { waitForPageCondition } from "./wait-for.mjs";
import { buildPageContextExpression } from "./page-context.mjs";

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function inferTitle(url) {
  if (!url) {
    return "Firefox Context";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
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

export function normalizeFirefoxContext(context) {
  return {
    targetId: context.context,
    type: "page",
    title: inferTitle(context.url),
    url: context.url,
    attached: false,
    userContext: context.userContext ?? null,
    clientWindow: context.clientWindow ?? null,
  };
}

export function resolveBidiEventContext(method, params = {}) {
  return (
    params.context ??
    params.source?.context ??
    params.navigation?.context ??
    null
  );
}

function normalizeMapEntries(entries) {
  return Object.fromEntries(
    entries.map(([key, value]) => [
      String(summarizeBidiRemoteValue(key)),
      summarizeBidiRemoteValue(value),
    ]),
  );
}

export function summarizeBidiRemoteValue(value) {
  if (!value || typeof value !== "object") {
    return value ?? null;
  }

  switch (value.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return value.value;
    case "array":
    case "set":
      return Array.isArray(value.value)
        ? value.value.map((entry) => summarizeBidiRemoteValue(entry))
        : [];
    case "object":
    case "map":
      return Array.isArray(value.value) ? normalizeMapEntries(value.value) : {};
    default:
      if (value.value !== undefined) {
        return value.value;
      }

      return {
        type: value.type,
        handle: value.handle ?? null,
        internalId: value.internalId ?? null,
      };
  }
}

function summarizeFirefoxStackFrames(callFrames = []) {
  return callFrames.map((frame) => ({
    functionName: frame.functionName || null,
    url: frame.url || null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  }));
}

function firstFirefoxCallFrame(stackTrace) {
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

function screenshotMimeType(format) {
  return format === "jpeg" ? "image/jpeg" : "image/png";
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

function normalizeFirefoxEvent(method, params = {}) {
  if (method === "log.entryAdded") {
    return {
      kind: "console",
      level: params.level,
      text: params.text,
      timestamp: params.timestamp,
      values: (params.args || []).map((arg) => summarizeBidiRemoteValue(arg)),
      source: firstFirefoxCallFrame(params.stackTrace),
      stackTrace: summarizeFirefoxStackFrames(params.stackTrace?.callFrames),
      realm: params.source?.realm ?? null,
      context: params.source?.context ?? null,
    };
  }

  if (method === "network.beforeRequestSent") {
    return {
      kind: "network",
      phase: "request",
      completed: false,
      timestamp: params.timestamp,
      requestId: params.request?.request,
      method: params.request?.method,
      url: params.request?.url,
      source: "protocol",
    };
  }

  if (method === "network.responseCompleted") {
    return {
      kind: "network",
      phase: "response",
      completed: true,
      failed: false,
      timestamp: params.timestamp,
      requestId: params.request?.request,
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      url: params.request?.url,
      source: "protocol",
    };
  }

  if (method === "browsingContext.load") {
    return {
      kind: "page",
      timestamp: params.timestamp ?? null,
      url: params.url ?? null,
      navigation: params.navigation ?? null,
      context: params.context ?? null,
    };
  }

  if (method === "browsingContext.contextDestroyed") {
    return {
      kind: "lifecycle",
      timestamp: new Date().toISOString(),
      context: params.context,
    };
  }

  return {
    kind: "raw",
    params,
  };
}

function screenshotFormat(format) {
  if (format === "png") {
    return { type: "image/png" };
  }

  if (format === "jpeg") {
    return { type: "image/jpeg" };
  }

  throw new Error(`Firefox BiDi screenshot format is not supported: ${format}`);
}

function normalizeRequestedDepth(depth) {
  return Number.isInteger(depth) && depth > 0 ? depth : 2;
}

function isHttpProtocol(protocol) {
  return protocol === "http:" || protocol === "https:";
}

function isRootPathname(pathname) {
  return pathname === "" || pathname === "/";
}

function toWebSocketEndpointUrl(endpointUrl) {
  const url = new URL(endpointUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  return url;
}

function joinUrlPath(baseUrl, pathname) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = pathname.replace(/^\/+/, "");
  url.pathname = `${basePath}/${nextPath}`.replace(/\/{2,}/g, "/");
  return url;
}

class FirefoxBidiTabSession {
  constructor(target, options = {}) {
    this.id = crypto.randomUUID();
    this.target = target;
    this.eventBufferSize = options.eventBufferSize ?? 200;
    this.connectedAt = new Date().toISOString();
    this.bufferedEvents = [];
    this.subscription = null;
    this.closed = false;
    this.lastNavigationAt = null;
    this.lastReloadAt = null;
    this.viewportOverride = null;
  }

  bufferEvent(method, params) {
    const capturedAt = new Date().toISOString();
    if (method === "browsingContext.load" && params.url) {
      this.target.url = params.url;
      this.lastNavigationAt = capturedAt;
    }

    this.pushEvent({
      method,
      capturedAt,
      ...normalizeFirefoxEvent(method, params),
    });
  }

  pushEvent(event) {
    this.bufferedEvents.push(event);
    if (this.bufferedEvents.length > this.eventBufferSize) {
      this.bufferedEvents.shift();
    }
  }

  getEvents(limit = 50) {
    const safeLimit = Math.max(1, limit);
    return this.bufferedEvents.slice(-safeLimit);
  }

  getConsoleMessages(limit = 50) {
    return filterConsoleMessages(this.bufferedEvents, limit);
  }

  getNetworkRequests(limit = 50) {
    return summarizeNetworkRequests(this.bufferedEvents, limit);
  }

  getSummary() {
    return {
      sessionId: this.id,
      targetId: this.target.targetId,
      title: this.target.title,
      url: this.target.url,
      browserFamily: "firefox",
      connectedAt: this.connectedAt,
      bufferedEvents: this.bufferedEvents.length,
      subscription: this.subscription,
      lastNavigationAt: this.lastNavigationAt,
      lastReloadAt: this.lastReloadAt,
      viewportOverride: this.viewportOverride,
    };
  }
}

export class FirefoxBidiSessionManager {
  constructor(config, options = {}) {
    this.config = config;
    this.sessions = new Map();
    this.websocketFactory =
      options.websocketFactory ?? ((url) => new WebSocket(url));
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 2_000;
    this.pending = new Map();
    this.nextMessageId = 1;
    this.websocket = null;
    this.browserSessionId = null;
    this.capabilities = null;
    this.connectPromise = null;
    this.resolvedWebSocketUrl = null;
  }

  async ensureConnected() {
    if (
      this.browserSessionId &&
      this.websocket?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.openConnection();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async openConnection() {
    const endpoint = await this.resolveConnectionEndpoint();
    this.resolvedWebSocketUrl = endpoint.webSocketUrl;
    this.websocket = this.websocketFactory(endpoint.webSocketUrl);

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        this.websocket?.close?.();
        reject(
          new Error(
            `Timed out connecting to Firefox BiDi at ${endpoint.webSocketUrl}`,
          ),
        );
      }, this.connectionTimeoutMs);
      timer.unref?.();

      const settle = (callback) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        callback();
      };

      this.websocket.addEventListener(
        "open",
        () => {
          settle(resolve);
        },
        { once: true },
      );

      this.websocket.addEventListener(
        "error",
        () => {
          settle(() => {
            reject(
              new Error(`Failed to connect to ${this.config.firefoxBidiWsUrl}`),
            );
          });
        },
        { once: true },
      );

      this.websocket.addEventListener("message", (event) => {
        void this.handleMessage(event.data);
      });

      this.websocket.addEventListener("close", () => {
        this.rejectPending(new Error("Firefox BiDi connection closed"));
        this.websocket = null;
        this.browserSessionId = null;
        this.capabilities = null;
        this.sessions.clear();
        settle(() => {
          reject(
            new Error("Firefox BiDi connection closed before it connected"),
          );
        });
      });
    });

    if (endpoint.requiresSessionNew) {
      const result = await this.send("session.new", {
        capabilities: {
          alwaysMatch: {},
        },
      });

      this.browserSessionId = result.sessionId;
      this.capabilities = result.capabilities ?? {};
      return;
    }

    this.browserSessionId = endpoint.sessionId;
    this.capabilities = endpoint.capabilities ?? {};
  }

  async resolveConnectionEndpoint() {
    const configuredUrl = new URL(this.config.firefoxBidiWsUrl);

    if (isHttpProtocol(configuredUrl.protocol)) {
      return {
        webSocketUrl: joinUrlPath(
          toWebSocketEndpointUrl(configuredUrl),
          "/session",
        ).toString(),
        requiresSessionNew: true,
        sessionId: null,
        capabilities: null,
      };
    }

    if (isRootPathname(configuredUrl.pathname)) {
      configuredUrl.pathname = "/session";
    }

    return {
      webSocketUrl: configuredUrl.toString(),
      requiresSessionNew: configuredUrl.pathname === "/session",
      sessionId:
        configuredUrl.pathname === "/session"
          ? null
          : configuredUrl.pathname.split("/").at(-1) ||
            configuredUrl.toString(),
      capabilities: null,
    };
  }

  async waitForWebSocketClose(websocket, timeoutMs = 250) {
    if (!websocket || websocket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      websocket.addEventListener("close", done, { once: true });
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
    });
  }

  async closeBrowserSession() {
    if (!this.browserSessionId) {
      return;
    }

    if (this.websocket?.readyState === WebSocket.OPEN) {
      await this.send("session.end", {}).catch(() => {});
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error("Firefox BiDi connection is not established");
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

  async handleMessage(data) {
    const raw = await readWebSocketData(data);
    const message = JSON.parse(raw);

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.type === "error") {
        pending.reject(
          new Error(message.message || message.error || "BiDi error"),
        );
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.type !== "event" || !message.method) {
      return;
    }

    const contextId = resolveBidiEventContext(message.method, message.params);
    if (!contextId) {
      return;
    }

    for (const session of this.sessions.values()) {
      if (session.target.targetId === contextId) {
        session.bufferEvent(message.method, message.params ?? {});
        if (message.method === "browsingContext.contextDestroyed") {
          session.closed = true;
          this.sessions.delete(session.id);
        }
      }
    }
  }

  async getBrowserStatus() {
    try {
      await this.ensureConnected();
      return {
        available: true,
        endpoint: this.config.firefoxBidiWsUrl,
        sessionCount: this.sessions.size,
        browser: this.capabilities?.browserName || "firefox",
        browserVersion: this.capabilities?.browserVersion ?? null,
        protocol: "webdriver-bidi",
        webSocketUrl: this.resolvedWebSocketUrl ?? this.config.firefoxBidiWsUrl,
      };
    } catch (error) {
      return {
        available: false,
        endpoint: this.config.firefoxBidiWsUrl,
        sessionCount: this.sessions.size,
        protocol: "webdriver-bidi",
        error: toErrorMessage(error),
      };
    }
  }

  async listTargets() {
    await this.ensureConnected();
    const result = await this.send("browsingContext.getTree", {});
    return (result.contexts || []).map((context) =>
      normalizeFirefoxContext(context),
    );
  }

  listSessions() {
    return Array.from(this.sessions.values(), (session) =>
      session.getSummary(),
    );
  }

  async createTab(url = "about:blank") {
    await this.ensureConnected();
    const targetUrl =
      typeof url === "string" && url.trim() ? url.trim() : "about:blank";
    const result = await this.send("browsingContext.create", {
      type: "tab",
    });
    const targetId = result.context;
    if (!targetId) {
      throw new Error(
        "Firefox did not return a browsing context id for the new tab",
      );
    }

    if (targetUrl !== "about:blank") {
      await this.send("browsingContext.navigate", {
        context: targetId,
        url: targetUrl,
        wait: "complete",
      });
    }

    const target = (await this.listTargets()).find(
      (candidate) => candidate.targetId === targetId,
    );

    return {
      browserFamily: "firefox",
      ...(target ?? {
        targetId,
        type: "page",
        title: inferTitle(targetUrl),
        url: targetUrl,
        attached: false,
        userContext: null,
        clientWindow: null,
      }),
    };
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No active session found for ${sessionId}`);
    }

    return session;
  }

  async attachToTarget(targetId) {
    const targets = await this.listTargets();
    const target = targets.find((candidate) => candidate.targetId === targetId);
    if (!target) {
      throw new Error(`No Firefox browsing context found for ${targetId}`);
    }

    const session = new FirefoxBidiTabSession(target, {
      eventBufferSize: this.config.eventBufferSize,
    });

    const subscription = await this.send("session.subscribe", {
      events: [
        "log.entryAdded",
        "network.beforeRequestSent",
        "network.responseCompleted",
        "browsingContext.load",
        "browsingContext.contextDestroyed",
      ],
      contexts: [targetId],
    });

    session.subscription = subscription.subscription ?? null;
    this.sessions.set(session.id, session);
    await this.seedBufferedState(session);
    return session.getSummary();
  }

  async detachSession(sessionId) {
    const session = this.getSession(sessionId);

    if (session.subscription) {
      await this.send("session.unsubscribe", {
        subscriptions: [session.subscription],
      }).catch(() => {});
    }

    session.closed = true;
    this.sessions.delete(sessionId);
    return {
      detached: true,
      sessionId,
    };
  }

  async closeTarget(targetId) {
    await this.ensureConnected();
    await this.send("browsingContext.close", {
      context: targetId,
    });

    const detachedSessions = Array.from(this.sessions.values())
      .filter((session) => session.target.targetId === targetId)
      .map((session) => {
        session.closed = true;
        this.sessions.delete(session.id);
        return { sessionId: session.id };
      });

    return {
      browserFamily: "firefox",
      closed: true,
      targetId,
      detachedSessions,
    };
  }

  async evaluate(sessionId, expression, options = {}) {
    const session = this.getSession(sessionId);
    const result = await this.evaluateInContext(session, expression, options);

    return {
      result:
        result.type === "success"
          ? summarizeBidiRemoteValue(result.result)
          : null,
      exceptionDetails:
        result.type === "exception" ? result.exceptionDetails : null,
      realm: result.realm ?? null,
    };
  }

  async evaluateInContext(session, expression, options = {}) {
    return this.send("script.evaluate", {
      expression,
      target: {
        context: session.target.targetId,
      },
      awaitPromise: options.awaitPromise ?? true,
      resultOwnership: "none",
      serializationOptions: options.serializationOptions ?? {
        maxObjectDepth: 5,
        maxDomDepth: 0,
      },
      userActivation: options.userActivation ?? false,
    });
  }

  async runPageAction(session, payload, options = {}) {
    const result = await this.evaluateInContext(
      session,
      buildPageContextExpression(
        {
          browserFamily: "firefox",
          ...payload,
        },
        { serialize: true },
      ),
      {
        awaitPromise: true,
        serializationOptions: {
          maxObjectDepth: 1,
          maxDomDepth: 0,
        },
        userActivation: options.userActivation ?? false,
      },
    );

    if (result.type !== "success") {
      throw new Error(
        result.exceptionDetails?.text || "Firefox page action failed",
      );
    }

    const payloadText = summarizeBidiRemoteValue(result.result);
    return JSON.parse(payloadText);
  }

  async getDocument(sessionId, depth) {
    const session = this.getSession(sessionId);
    const requestedDepth = normalizeRequestedDepth(depth);
    const result = await this.evaluateInContext(
      session,
      `JSON.stringify({
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        requestedDepth: ${JSON.stringify(requestedDepth)},
        outerHTML: document.documentElement ? document.documentElement.outerHTML : null
      })`,
      {
        serializationOptions: {
          maxObjectDepth: 1,
          maxDomDepth: 0,
        },
      },
    );

    if (result.type !== "success") {
      return {
        exceptionDetails: result.exceptionDetails ?? null,
      };
    }

    const payload = summarizeBidiRemoteValue(result.result);
    return {
      browserFamily: "firefox",
      format: "html",
      ...JSON.parse(payload),
    };
  }

  async getPageState(sessionId) {
    const session = this.getSession(sessionId);
    const result = await this.runPageAction(session, {
      action: "page_state",
    });

    return {
      browserFamily: "firefox",
      ...result.page,
      lastNavigationAt: session.lastNavigationAt,
      lastReloadAt: session.lastReloadAt,
      viewportOverride: session.viewportOverride,
    };
  }

  async waitFor(sessionId, options = {}) {
    return waitForPageCondition({
      getPageState: () => this.getPageState(sessionId),
      inspectElement: (selector) => this.inspectElement(sessionId, selector),
      options,
    });
  }

  async navigate(sessionId, url, options = {}) {
    const session = this.getSession(sessionId);
    const waitUntil = normalizeWaitUntil(options.waitUntil);
    const initiatedAt = new Date().toISOString();
    const result = await this.send("browsingContext.navigate", {
      context: session.target.targetId,
      url,
      wait: waitUntil,
    });

    session.target.url = url;
    const page =
      waitUntil === "none" ? null : await this.getPageState(sessionId);
    return {
      browserFamily: "firefox",
      url,
      navigation: result.navigation ?? null,
      waitUntil,
      initiatedAt,
      page,
    };
  }

  async reload(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    const waitUntil = normalizeWaitUntil(options.waitUntil);
    const reloadedAt = new Date().toISOString();
    const result = await this.send("browsingContext.reload", {
      context: session.target.targetId,
      ignoreCache: options.ignoreCache ?? false,
      wait: waitUntil,
    });

    session.lastReloadAt = reloadedAt;
    const page =
      waitUntil === "none" ? null : await this.getPageState(sessionId);
    return {
      browserFamily: "firefox",
      url: session.target.url,
      navigation: result.navigation ?? null,
      waitUntil,
      ignoreCache: options.ignoreCache ?? false,
      reloadedAt,
      page,
    };
  }

  async click(sessionId, selector) {
    return this.runPageAction(
      this.getSession(sessionId),
      {
        action: "click",
        selector,
      },
      { userActivation: true },
    );
  }

  async hover(sessionId, selector) {
    return this.runPageAction(
      this.getSession(sessionId),
      {
        action: "hover",
        selector,
      },
      { userActivation: true },
    );
  }

  async type(sessionId, selector, text, options = {}) {
    return this.runPageAction(
      this.getSession(sessionId),
      {
        action: "type",
        selector,
        text,
        clear: options.clear,
      },
      { userActivation: true },
    );
  }

  async select(sessionId, selector, options = {}) {
    return this.runPageAction(
      this.getSession(sessionId),
      {
        action: "select",
        selector,
        value: options.value,
        label: options.label,
      },
      { userActivation: true },
    );
  }

  async pressKey(sessionId, key, selector = null) {
    return this.runPageAction(
      this.getSession(sessionId),
      {
        action: "press_key",
        key,
        selector,
      },
      { userActivation: true },
    );
  }

  async scroll(sessionId, options = {}) {
    return this.runPageAction(
      this.getSession(sessionId),
      {
        action: "scroll",
        selector: options.selector,
        deltaX: options.deltaX,
        deltaY: options.deltaY,
        block: options.block,
      },
      { userActivation: true },
    );
  }

  async setViewport(sessionId, options) {
    const session = this.getSession(sessionId);
    const params = {
      context: session.target.targetId,
      viewport: {
        width: options.width,
        height: options.height,
      },
    };

    if (
      typeof options.deviceScaleFactor === "number" &&
      options.deviceScaleFactor > 0
    ) {
      params.devicePixelRatio = options.deviceScaleFactor;
    }

    await this.send("browsingContext.setViewport", params);
    session.viewportOverride = {
      width: options.width,
      height: options.height,
      deviceScaleFactor: params.devicePixelRatio ?? null,
      mobile: options.mobile ?? false,
      appliedAt: new Date().toISOString(),
    };

    return {
      browserFamily: "firefox",
      applied: true,
      viewport: session.viewportOverride,
      page: await this.getPageState(sessionId),
    };
  }

  async takeScreenshot(sessionId, format, options = {}) {
    const session = this.getSession(sessionId);
    const params = {
      context: session.target.targetId,
      format: screenshotFormat(format),
    };

    if (options.selector) {
      const inspected = await this.runPageAction(session, {
        action: "inspect",
        selector: options.selector,
        scrollIntoView: true,
      });

      if (!inspected.found) {
        return {
          browserFamily: "firefox",
          format,
          scope: "element",
          selector: options.selector,
          found: false,
        };
      }

      params.origin = "viewport";
      params.clip = {
        type: "box",
        x: Math.max(inspected.node.box?.x ?? 0, 0),
        y: Math.max(inspected.node.box?.y ?? 0, 0),
        width: Math.max(inspected.node.box?.width ?? 0, 1),
        height: Math.max(inspected.node.box?.height ?? 0, 1),
      };
    }

    const screenshot = await this.send(
      "browsingContext.captureScreenshot",
      params,
    );
    return formatScreenshotResult(screenshot.data, format, {
      browserFamily: "firefox",
      scope: options.selector ? "element" : "page",
      selector: options.selector ?? null,
      clip: params.clip ?? null,
    });
  }

  getConsoleMessages(sessionId, limit) {
    return this.getSession(sessionId).getConsoleMessages(limit);
  }

  getNetworkRequests(sessionId, limit) {
    return this.getSession(sessionId).getNetworkRequests(limit);
  }

  async inspectElement(sessionId, selector) {
    return this.runPageAction(this.getSession(sessionId), {
      action: "inspect",
      selector,
    });
  }

  async seedBufferedState(session) {
    try {
      const snapshot = await this.runPageAction(session, {
        action: "network_snapshot",
      });

      for (const entry of snapshot?.entries ?? []) {
        session.pushEvent({
          method: "network.snapshotCaptured",
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
      // Ignore snapshot failures so attach still succeeds.
    }
  }

  getEvents(sessionId, limit) {
    return this.getSession(sessionId).getEvents(limit);
  }

  async closeAll() {
    await Promise.allSettled(
      Array.from(this.sessions.keys(), (sessionId) =>
        this.detachSession(sessionId),
      ),
    );

    const websocket = this.websocket;

    await this.closeBrowserSession();

    if (websocket && websocket.readyState < WebSocket.CLOSING) {
      websocket.close();
      await this.waitForWebSocketClose(websocket);
    }

    this.sessions.clear();
    this.websocket = null;
    this.browserSessionId = null;
    this.capabilities = null;
    this.resolvedWebSocketUrl = null;
  }
}
