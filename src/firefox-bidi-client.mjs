import {
  exportHarLikeSummary,
  filterConsoleMessages,
  InFlightRequests,
  summarizeNetworkRequests,
} from "./session-events.mjs";
import { DEFAULT_FIREFOX_BIDI_WS_URL } from "./config.mjs";
import { wrapTopLevelAwait } from "./top-level-await.mjs";
import { waitForPageCondition } from "./wait-for.mjs";
import {
  assertEnabled,
  assertPointerTarget,
  buildInputRecorderExpression,
  buildPageContextExpression,
} from "./page-context.mjs";
import { buildBidiKeyActions, buildBidiTextActions } from "./keyboard.mjs";
import { sendCheckedInput } from "./input-delivery.mjs";
import {
  applyNetworkOptions,
  describeNetworkState,
  inNetworkTurn,
  mockHeaders,
  takeMatchingRule,
  throttled,
} from "./network-control.mjs";
import {
  takeFileTarget,
  assertFileInput,
  uploadResult,
  describePointer,
  dragEnd,
  dragPath,
  pointerFields,
  takeNextRef,
  wheelScroll,
} from "./page-context.mjs";

const MOUSE_BUTTON_NUMBERS = { left: 0, middle: 1, right: 2 };
// Each step of a drag takes this long, so the page sees the moves as a
// gesture rather than one jump.
const DRAG_MOVE_MS = 16;

const POINTER_SOURCE = {
  type: "pointer",
  id: "mcp-mouse",
  parameters: { pointerType: "mouse" },
};

function pointerMove(point) {
  return {
    type: "pointerMove",
    x: Math.round(point.x),
    y: Math.round(point.y),
    origin: "viewport",
  };
}

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

// Names a request's type as CDP does where BiDi says enough: a document,
// fetch, or XHR. Older Firefox releases report neither field, so the type
// stays unknown.
export function bidiResourceType(request = {}) {
  const { destination, initiatorType } = request;
  if (destination === undefined && initiatorType === undefined) {
    return null;
  }
  if (destination === "document" || destination === "iframe") {
    return "Document";
  }
  if (initiatorType === "fetch") {
    return "Fetch";
  }
  if (initiatorType === "xmlhttprequest") {
    return "XHR";
  }
  return destination || initiatorType || "Other";
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
      resourceType: bidiResourceType(params.request),
      navigation: params.navigation ?? null,
      source: "protocol",
    };
  }

  if (method === "network.fetchError") {
    return {
      kind: "network",
      phase: "failed",
      completed: true,
      failed: true,
      timestamp: params.timestamp,
      requestId: params.request?.request,
      url: params.request?.url,
      errorText: params.errorText ?? null,
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

  if (
    method === "browsingContext.userPromptOpened" ||
    method === "browsingContext.userPromptClosed"
  ) {
    return {
      kind: "dialog",
      phase:
        method === "browsingContext.userPromptOpened" ? "opened" : "closed",
      dialogType: params.type ?? null,
      message: params.message ?? null,
      defaultValue: params.defaultValue ?? null,
      context: params.context ?? null,
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

function buildDiscoveryWebSocketUrls(configuredUrl) {
  const configured = new URL(configuredUrl);
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
    this.inFlight = new InFlightRequests();
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
    this.inFlight.observe(event);
    this.bufferedEvents.push(event);
    if (this.bufferedEvents.length > this.eventBufferSize) {
      this.bufferedEvents.shift();
    }
  }

  getEvents(limit = 50) {
    const safeLimit = Math.max(1, limit);
    return this.bufferedEvents.slice(-safeLimit);
  }

  pendingRequests() {
    return this.inFlight.list();
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
    this.discoveredEndpointUrl = null;
    this.resolvedWebSocketUrl = null;
  }

  shouldAutoDiscoverEndpoint() {
    return this.config.firefoxBidiWsUrl === DEFAULT_FIREFOX_BIDI_WS_URL;
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
    const candidates = this.shouldAutoDiscoverEndpoint()
      ? buildDiscoveryWebSocketUrls(this.config.firefoxBidiWsUrl)
      : [this.config.firefoxBidiWsUrl];
    let lastError = null;

    for (const candidate of candidates) {
      const endpoint = this.resolveConnectionEndpoint(candidate);
      try {
        await this.openConnectionAt(endpoint);
        this.discoveredEndpointUrl = candidate;
        return;
      } catch (error) {
        lastError = error;
        await this.resetConnectionState();
      }
    }

    throw (
      lastError ?? new Error("Unable to connect to a Firefox BiDi endpoint")
    );
  }

  async openConnectionAt(endpoint) {
    const websocket = this.websocketFactory(endpoint.webSocketUrl);
    this.websocket = websocket;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        websocket.close?.();
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

      websocket.addEventListener(
        "open",
        () => {
          settle(resolve);
        },
        { once: true },
      );

      websocket.addEventListener(
        "error",
        () => {
          settle(() => {
            reject(new Error(`Failed to connect to ${endpoint.webSocketUrl}`));
          });
        },
        { once: true },
      );

      websocket.addEventListener("message", (event) => {
        if (this.websocket !== websocket) {
          return;
        }

        void this.handleMessage(event.data);
      });

      websocket.addEventListener("close", () => {
        if (this.websocket !== websocket) {
          return;
        }

        this.rejectPending(new Error("Firefox BiDi connection closed"));
        this.websocket = null;
        this.browserSessionId = null;
        this.capabilities = null;
        this.discoveredEndpointUrl = null;
        this.resolvedWebSocketUrl = null;
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
      this.resolvedWebSocketUrl = endpoint.webSocketUrl;
      return;
    }

    this.browserSessionId = endpoint.sessionId;
    this.capabilities = endpoint.capabilities ?? {};
    this.resolvedWebSocketUrl = endpoint.webSocketUrl;
  }

  async resetConnectionState() {
    if (this.websocket?.readyState < WebSocket.CLOSING) {
      this.websocket.close();
      await this.waitForWebSocketClose(this.websocket, 50);
    }

    this.rejectPending(new Error("Firefox BiDi connection closed"));
    this.websocket = null;
    this.browserSessionId = null;
    this.capabilities = null;
    this.discoveredEndpointUrl = null;
    this.resolvedWebSocketUrl = null;
  }

  resolveConnectionEndpoint(endpointUrl = this.config.firefoxBidiWsUrl) {
    const configuredUrl = new URL(endpointUrl);

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

    // A paused request is routed by its intercept, not its context, since
    // a tab's intercept also pauses its iframes' requests.
    if (
      message.method === "network.beforeRequestSent" &&
      message.params?.isBlocked
    ) {
      this.routeBlockedRequest(message.params);
    }

    const contextId = resolveBidiEventContext(message.method, message.params);
    if (!contextId) {
      return;
    }

    if (message.method === "browsingContext.userPromptOpened") {
      const accept = message.params?.type !== "prompt";
      this.send("browsingContext.handleUserPrompt", {
        context: contextId,
        accept,
      }).catch(() => {});
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
        endpoint: this.discoveredEndpointUrl ?? this.config.firefoxBidiWsUrl,
        sessionCount: this.sessions.size,
        browser: this.capabilities?.browserName || "firefox",
        browserVersion: this.capabilities?.browserVersion ?? null,
        protocol: "webdriver-bidi",
        webSocketUrl:
          this.resolvedWebSocketUrl ??
          this.discoveredEndpointUrl ??
          this.config.firefoxBidiWsUrl,
      };
    } catch (error) {
      return {
        available: false,
        endpoint: this.discoveredEndpointUrl ?? this.config.firefoxBidiWsUrl,
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
        "network.fetchError",
        "browsingContext.load",
        "browsingContext.contextDestroyed",
        "browsingContext.userPromptOpened",
        "browsingContext.userPromptClosed",
      ],
      contexts: [targetId],
    });

    session.subscription = subscription.subscription ?? null;
    this.sessions.set(session.id, session);
    await this.installInputRecorder(session);
    await this.seedBufferedState(session);
    return session.getSummary();
  }

  async detachSession(sessionId) {
    const session = this.getSession(sessionId);
    // A network call in progress finishes first, so its intercept and
    // offline setting are known here and removed.
    await inNetworkTurn(session, async () => {
      session.closed = true;
      if (session.interceptId) {
        await this.send("network.removeIntercept", {
          intercept: session.interceptId,
        }).catch(() => {});
        session.interceptId = null;
      }
      if (session.network?.offline) {
        await this.send("emulation.setNetworkConditions", {
          networkConditions: null,
          contexts: [session.target.targetId],
        }).catch(() => {});
      }
    });

    if (session.subscription) {
      await this.send("session.unsubscribe", {
        subscriptions: [session.subscription],
      }).catch(() => {});
    }
    if (session.inputRecorderScript) {
      await this.send("script.removePreloadScript", {
        script: session.inputRecorderScript,
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
    const result = await this.evaluateInContext(
      session,
      wrapTopLevelAwait(expression) ?? expression,
      options,
    );

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
      inspectElement: (selector, options) =>
        this.inspectElement(sessionId, selector, options),
      evaluate: (expression) => this.evaluate(sessionId, expression),
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

  async performActions(session, actions) {
    await this.send("input.performActions", {
      context: session.target.targetId,
      actions,
    });
  }

  async performKeyActions(session, actions) {
    await this.performActions(session, [
      { type: "key", id: "mcp-keyboard", actions },
    ]);
  }

  async resolvePointerTarget(session, selector, options = {}) {
    const target = await this.runPageAction(session, {
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
  async resolvePointer(session, target, options = {}) {
    if (typeof target === "string") {
      return this.resolvePointerTarget(session, target, options);
    }
    return this.runSnapshotAction(session.id, {
      action: "point_target",
      x: target.x,
      y: target.y,
      ...(options.inputProbe ? { inputProbe: options.inputProbe } : {}),
    });
  }

  async readInputProbe(session, token, disarm) {
    try {
      const probe = await this.runPageAction(session, {
        action: "input_probe",
        token,
        disarm,
      });
      return probe.armed ? probe : null;
    } catch {
      return null;
    }
  }

  async click(sessionId, target, options = {}) {
    const session = this.getSession(sessionId);
    const token = crypto.randomUUID();
    const resolved = await this.resolvePointer(session, target, {
      inputProbe: token,
    });
    if (!resolved.found) {
      return resolved;
    }
    if (typeof target === "string") {
      assertEnabled(resolved);
    }

    const button = MOUSE_BUTTON_NUMBERS[options.button ?? "left"];
    const presses = [];
    for (let count = 0; count < (options.clickCount ?? 1); count += 1) {
      presses.push(
        { type: "pointerDown", button },
        { type: "pointerUp", button },
      );
    }
    const delivery = await sendCheckedInput({
      send: () =>
        this.performActions(session, [
          {
            ...POINTER_SOURCE,
            actions: [pointerMove(resolved.point), ...presses],
          },
        ]),
      readProbe: (disarm) => this.readInputProbe(session, token, disarm),
      describe: `The click on ${describePointer(target)}`,
    });

    return {
      browserFamily: "firefox",
      found: true,
      clicked: true,
      ...(delivery.resent ? { resent: true } : {}),
      ...pointerFields(target, resolved, delivery.node ?? resolved.node),
    };
  }

  async hover(sessionId, target) {
    const session = this.getSession(sessionId);
    const resolved = await this.resolvePointer(session, target);
    if (!resolved.found) {
      return resolved;
    }

    await this.performActions(session, [
      { ...POINTER_SOURCE, actions: [pointerMove(resolved.point)] },
    ]);

    return {
      browserFamily: "firefox",
      found: true,
      hovered: true,
      ...pointerFields(target, resolved),
    };
  }

  // Presses at from, moves through dragPath, and releases at to. The press
  // is checked for delivery on its own; the pointer stays down between the
  // two performActions calls, since the session keeps its input state.
  async drag(sessionId, from, to, options = {}) {
    const session = this.getSession(sessionId);
    const token = crypto.randomUUID();
    const source = await this.resolvePointer(session, from, {
      inputProbe: token,
    });
    if (!source.found) {
      await this.readInputProbe(session, token, true);
      return source;
    }
    // The drop point is read without scrolling, so the source stays put.
    const target = await this.resolvePointer(session, to, {
      scrollIntoView: false,
    });
    if (!target.found) {
      await this.readInputProbe(session, token, true);
      return target;
    }

    const html5 = { from: source.point, to: target.point };
    const { html5: draggable } = await this.runPageAction(session, {
      action: "html5_drag",
      ...html5,
      check: true,
    });
    if (draggable) {
      await this.readInputProbe(session, token, true);
      const { dropped } = await this.runPageAction(session, {
        action: "html5_drag",
        ...html5,
      });
      return {
        browserFamily: "firefox",
        found: true,
        dragged: true,
        html5: true,
        synthetic: true,
        dropped,
        from: dragEnd(from, source),
        to: dragEnd(to, target),
      };
    }

    let delivery;
    try {
      delivery = await sendCheckedInput({
        send: () =>
          this.performActions(session, [
            {
              ...POINTER_SOURCE,
              actions: [
                pointerMove(source.point),
                { type: "pointerDown", button: 0 },
              ],
            },
          ]),
        readProbe: (disarm) => this.readInputProbe(session, token, disarm),
        describe: `The press to drag ${describePointer(from)}`,
      });
      await this.performActions(session, [
        {
          ...POINTER_SOURCE,
          actions: [
            ...dragPath(source.point, target.point, options.steps).map(
              (point) => ({ ...pointerMove(point), duration: DRAG_MOVE_MS }),
            ),
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
    } catch (error) {
      // A drag that failed partway must not leave the button down for the
      // next action.
      await this.send("input.releaseActions", {
        context: session.target.targetId,
      }).catch(() => {});
      throw error;
    }

    return {
      browserFamily: "firefox",
      found: true,
      dragged: true,
      html5: false,
      ...(delivery.resent ? { resent: true } : {}),
      from: dragEnd(from, source),
      to: dragEnd(to, target),
    };
  }

  async type(sessionId, selector, text, options = {}) {
    const session = this.getSession(sessionId);
    const token = crypto.randomUUID();
    const prepared = await this.runPageAction(
      session,
      {
        action: "prepare_type",
        selector,
        text,
        clear: options.clear,
        inputProbe: token,
      },
      { userActivation: true },
    );
    if (!prepared.found || prepared.method !== "native") {
      return prepared;
    }

    let delivery = { node: null, resent: false };
    if (text || options.clear !== false) {
      const actions = text
        ? buildBidiTextActions(text)
        : buildBidiKeyActions("Backspace");
      delivery = await sendCheckedInput({
        send: () => this.performKeyActions(session, actions),
        readProbe: (disarm) => this.readInputProbe(session, token, disarm),
        describe: `The text for "${selector}"`,
      });
    } else {
      await this.readInputProbe(session, token, true);
    }

    let node = delivery.node;
    if (!node) {
      const typed = await this.runPageAction(session, {
        action: "inspect",
        selector,
        scrollIntoView: false,
      });
      node = typed.found ? typed.node : prepared.node;
    }

    return {
      browserFamily: "firefox",
      selector,
      found: true,
      typedText: text,
      ...(delivery.resent ? { resent: true } : {}),
      node,
    };
  }

  // Sets files on a file input. WebDriver BiDi sets them on an element; a
  // button that opens a chooser from script needs its hidden input passed.
  // BiDi URL patterns cannot express globs, so the tab's requests are all
  // intercepted while there are rules or extra headers, and each is matched
  // here. Throttling has no BiDi command.
  async setNetwork(sessionId, options) {
    const session = this.getSession(sessionId);
    // One call at a time per tab, so two calls cannot each add an intercept.
    return inNetworkTurn(session, () => {
      if (session.closed) {
        throw new Error(`Session ${sessionId} was detached`);
      }
      return this.applyNetwork(session, options);
    });
  }

  async applyNetwork(session, options) {
    const state = applyNetworkOptions(session.network, options);
    if (throttled(state)) {
      throw new Error(
        "latencyMs, downloadKbps, and uploadKbps are Chromium only; Firefox has no network throttling over WebDriver BiDi",
      );
    }
    if (options.offline !== undefined || options.reset) {
      try {
        await this.send("emulation.setNetworkConditions", {
          networkConditions: state.offline ? { type: "offline" } : null,
          contexts: [session.target.targetId],
        });
      } catch (error) {
        if (state.offline) {
          throw new Error(
            `This Firefox cannot emulate offline: ${toErrorMessage(error)}`,
            { cause: error },
          );
        }
      }
    }
    // The rules apply before the intercept exists, so the first request it
    // pauses is already answered by them.
    session.network = state;
    const intercepting =
      state.rules.length > 0 || Object.keys(state.headers).length > 0;
    if (intercepting && !session.interceptId) {
      this.addingIntercepts = (this.addingIntercepts ?? 0) + 1;
      try {
        const added = await this.send("network.addIntercept", {
          phases: ["beforeRequestSent"],
          contexts: [session.target.targetId],
        });
        session.interceptId = added.intercept;
        if (session.closed) {
          await this.send("network.removeIntercept", {
            intercept: added.intercept,
          }).catch(() => {});
          session.interceptId = null;
        }
      } finally {
        this.addingIntercepts -= 1;
        for (const params of (this.unrouted ?? []).splice(0)) {
          this.routeBlockedRequest(params);
        }
      }
    } else if (!intercepting && session.interceptId) {
      const intercept = session.interceptId;
      session.interceptId = null;
      await this.send("network.removeIntercept", { intercept }).catch(() => {});
    }
    return { browserFamily: "firefox", ...describeNetworkState(state) };
  }

  // Every intercept on this connection is one of ours. A paused request no
  // session claims either belongs to an intercept still being added, and
  // waits for it, or to one just removed, and is let go.
  routeBlockedRequest(params) {
    const owner = Array.from(this.sessions.values()).find(
      (session) =>
        session.interceptId && params.intercepts?.includes(session.interceptId),
    );
    if (owner) {
      void this.handleBlockedRequest(owner, params);
    } else if (this.addingIntercepts > 0) {
      (this.unrouted ??= []).push(params);
    } else {
      this.send("network.continueRequest", {
        request: params.request?.request,
      }).catch(() => {});
    }
  }

  async handleBlockedRequest(session, params) {
    const request = params.request?.request;
    const rule = takeMatchingRule(session.network, params.request?.url ?? "");
    const stringValue = (value) => ({ type: "string", value });
    try {
      if (rule?.action === "block") {
        await this.send("network.failRequest", { request });
      } else if (rule) {
        await this.send("network.provideResponse", {
          request,
          statusCode: rule.status,
          headers: mockHeaders(rule).map(({ name, value }) => ({
            name,
            value: stringValue(value),
          })),
          body: stringValue(rule.body),
        });
      } else {
        const extra = session.network?.headers ?? {};
        const names = new Set(
          Object.keys(extra).map((name) => name.toLowerCase()),
        );
        const headers =
          names.size === 0
            ? undefined
            : [
                ...(params.request?.headers ?? []).filter(
                  (header) => !names.has(header.name.toLowerCase()),
                ),
                ...Object.entries(extra).map(([name, value]) => ({
                  name,
                  value: stringValue(String(value)),
                })),
              ];
        await this.send("network.continueRequest", {
          request,
          ...(headers ? { headers } : {}),
        });
      }
    } catch {
      // Release the request if it is still paused; it may also have gone
      // away, for example because the page navigated.
      await this.send("network.continueRequest", { request }).catch(() => {});
    }
  }

  async uploadFiles(sessionId, selector, files) {
    const session = this.getSession(sessionId);
    const token = crypto.randomUUID();
    const target = await this.runPageAction(session, {
      action: "file_input",
      selector,
      token,
      clear: files.length === 0,
    });
    if (!target.found) {
      return target;
    }
    if (target.cleared) {
      return uploadResult("firefox", selector, files);
    }
    if (!target.fileInput) {
      throw new Error(
        `"${selector}" is not a file input and has none inside; on Firefox, pass the <input type="file">, which may be hidden`,
      );
    }
    const handle = await this.evaluateInContext(session, takeFileTarget(token));
    const sharedId = handle.result?.sharedId;
    assertFileInput(target, files);
    await this.send("input.setFiles", {
      context: session.target.targetId,
      element: { sharedId },
      files,
    });
    return uploadResult("firefox", selector, files, {
      multiple: target.multiple,
      accept: target.accept,
    });
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
    const session = this.getSession(sessionId);
    const actions = buildBidiKeyActions(key);
    const token = crypto.randomUUID();
    const focused = await this.runPageAction(
      session,
      {
        action: "focus",
        selector,
        inputProbe: token,
      },
      { userActivation: true },
    );
    if (!focused.found) {
      return focused;
    }

    const delivery = await sendCheckedInput({
      send: () => this.performKeyActions(session, actions),
      readProbe: (disarm) => this.readInputProbe(session, token, disarm),
      describe: `The key press "${key}"`,
    });

    return {
      browserFamily: "firefox",
      key,
      dispatched: true,
      ...(delivery.resent ? { resent: true } : {}),
      target: focused.target,
    };
  }

  // A selector alone scrolls its element into view and deltas alone scroll
  // the page. Coordinates, or a selector with deltas, send a real mouse
  // wheel there, which scrolls whatever is under the pointer.
  async scroll(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    if (wheelScroll(options)) {
      const target = options.selector ?? { x: options.x, y: options.y };
      const resolved = await this.resolvePointer(session, target);
      if (!resolved.found) {
        return resolved;
      }
      const wheel = {
        deltaX: options.deltaX ?? 0,
        deltaY: options.deltaY ?? 0,
      };
      await this.performActions(session, [
        {
          type: "wheel",
          id: "mcp-wheel",
          actions: [
            {
              type: "scroll",
              x: Math.round(resolved.point.x),
              y: Math.round(resolved.point.y),
              ...wheel,
              origin: "viewport",
            },
          ],
        },
      ]);
      return {
        browserFamily: "firefox",
        found: true,
        scrolled: true,
        wheel,
        ...pointerFields(target, resolved),
      };
    }
    return this.runPageAction(
      session,
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

  async getCookies(sessionId) {
    return this.runPageAction(this.getSession(sessionId), {
      action: "cookie_snapshot",
    });
  }

  async getStorage(sessionId) {
    return this.runPageAction(this.getSession(sessionId), {
      action: "storage_snapshot",
    });
  }

  async captureDebugReport(sessionId, options = {}) {
    const session = this.getSession(sessionId);
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
    const snapshot = await this.runPageAction(session, {
      action: "debug_report",
    });

    return {
      browserFamily: "firefox",
      capturedAt: new Date().toISOString(),
      page: {
        ...(await this.getPageState(sessionId)),
      },
      cookies: snapshot.cookies,
      storage: snapshot.storage,
      console: session.getConsoleMessages(consoleLimit),
      network: session.getNetworkRequests(networkLimit),
      screenshot: includeScreenshot
        ? await this.takeScreenshot(sessionId, screenshotFormat)
        : null,
    };
  }

  getHar(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    return exportHarLikeSummary(session.bufferedEvents, {
      limit: options.limit ?? 50,
      page: {
        title: session.target.title,
        url: session.target.url,
      },
    });
  }

  async captureSessionSnapshot(sessionId) {
    return {
      browserFamily: "firefox",
      capturedAt: new Date().toISOString(),
      page: await this.getPageState(sessionId),
      ...(await this.getCookies(sessionId)),
      ...(await this.getStorage(sessionId)),
    };
  }

  async restoreSessionSnapshot(sessionId, snapshot, options = {}) {
    const result = await this.runPageAction(this.getSession(sessionId), {
      action: "restore_snapshot",
      snapshot,
      clearStorage: options.clearStorage === true,
    });

    return {
      ...result,
      page: await this.getPageState(sessionId),
    };
  }

  async runSnapshotAction(sessionId, payload) {
    const session = this.getSession(sessionId);
    const result = await this.runPageAction(session, {
      ...payload,
      refStart: session.refStart ?? 1,
    });
    return takeNextRef(session, result);
  }

  async snapshotControls(sessionId) {
    return this.runSnapshotAction(sessionId, { action: "controls_snapshot" });
  }

  async trackChanges(sessionId, phase, options = {}) {
    return this.runSnapshotAction(sessionId, {
      action: `change_${phase}`,
      ...options,
    });
  }

  async snapshotPage(sessionId, options = {}) {
    return this.runSnapshotAction(sessionId, {
      action: "snapshot",
      ...options,
    });
  }

  async readText(sessionId, options = {}) {
    return this.runPageAction(this.getSession(sessionId), {
      action: "read_text",
      ...options,
    });
  }

  async inspectElement(sessionId, selector, options = {}) {
    return this.runPageAction(this.getSession(sessionId), {
      action: "inspect",
      selector,
      textChecks: options.textChecks,
    });
  }

  // Counts trusted input from the start of every later document, and from
  // now on in the current one, so input actions can check that their input
  // arrived. Without it they are reported as sent, unchecked.
  async installInputRecorder(session) {
    try {
      const preload = await this.send("script.addPreloadScript", {
        functionDeclaration: `() => ${buildInputRecorderExpression(true)}`,
        contexts: [session.target.targetId],
      });
      session.inputRecorderScript = preload?.script ?? null;
      await this.evaluateInContext(
        session,
        buildInputRecorderExpression(false),
        { awaitPromise: false },
      );
    } catch {
      // Ignore recorder failures so attach still succeeds.
    }
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

  pendingRequests(sessionId) {
    return this.getSession(sessionId).pendingRequests();
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
