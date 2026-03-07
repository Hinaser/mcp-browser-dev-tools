import {
  filterConsoleMessages,
  summarizeNetworkRequests,
} from "./session-events.mjs";

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
  return params.context ?? params.source?.context ?? params.navigation?.context ?? null;
}

function normalizeMapEntries(entries) {
  return Object.fromEntries(
    entries.map(([key, value]) => [String(summarizeBidiRemoteValue(key)), summarizeBidiRemoteValue(value)]),
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

function normalizeFirefoxEvent(method, params = {}) {
  if (method === "log.entryAdded") {
    return {
      kind: "console",
      level: params.level,
      text: params.text,
      timestamp: params.timestamp,
      values: (params.args || []).map((arg) => summarizeBidiRemoteValue(arg)),
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
    };
  }

  if (method === "browsingContext.load") {
    return {
      kind: "page",
      timestamp: params.timestamp ?? null,
      url: params.url ?? null,
      navigation: params.navigation ?? null,
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

class FirefoxBidiTabSession {
  constructor(target, options = {}) {
    this.id = crypto.randomUUID();
    this.target = target;
    this.eventBufferSize = options.eventBufferSize ?? 200;
    this.connectedAt = new Date().toISOString();
    this.bufferedEvents = [];
    this.subscription = null;
    this.closed = false;
  }

  bufferEvent(method, params) {
    this.bufferedEvents.push({
      method,
      capturedAt: new Date().toISOString(),
      ...normalizeFirefoxEvent(method, params),
    });

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
    };
  }
}

export class FirefoxBidiSessionManager {
  constructor(config, options = {}) {
    this.config = config;
    this.sessions = new Map();
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url));
    this.pending = new Map();
    this.nextMessageId = 1;
    this.websocket = null;
    this.browserSessionId = null;
    this.capabilities = null;
    this.connectPromise = null;
  }

  async ensureConnected() {
    if (this.browserSessionId && this.websocket?.readyState === WebSocket.OPEN) {
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
    this.websocket = this.websocketFactory(this.config.firefoxBidiWsUrl);

    await new Promise((resolve, reject) => {
      let settled = false;

      this.websocket.addEventListener(
        "open",
        () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        { once: true },
      );

      this.websocket.addEventListener(
        "error",
        () => {
          if (!settled) {
            settled = true;
            reject(new Error(`Failed to connect to ${this.config.firefoxBidiWsUrl}`));
          }
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
        if (!settled) {
          settled = true;
          reject(new Error("Firefox BiDi connection closed before it connected"));
        }
      });
    });

    const result = await this.send("session.new", {
      capabilities: {
        alwaysMatch: {},
      },
    });

    this.browserSessionId = result.sessionId;
    this.capabilities = result.capabilities ?? {};
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
        pending.reject(new Error(message.message || message.error || "BiDi error"));
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
        webSocketUrl: this.config.firefoxBidiWsUrl,
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
    return (result.contexts || []).map((context) => normalizeFirefoxContext(context));
  }

  listSessions() {
    return Array.from(this.sessions.values(), (session) => session.getSummary());
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

  async evaluate(sessionId, expression, options = {}) {
    const session = this.getSession(sessionId);
    const result = await this.send("script.evaluate", {
      expression,
      target: {
        context: session.target.targetId,
      },
      awaitPromise: options.awaitPromise ?? true,
      resultOwnership: "none",
      serializationOptions: {
        maxObjectDepth: 5,
        maxDomDepth: 0,
      },
      userActivation: false,
    });

    return {
      result:
        result.type === "success" ? summarizeBidiRemoteValue(result.result) : null,
      exceptionDetails: result.type === "exception" ? result.exceptionDetails : null,
      realm: result.realm ?? null,
    };
  }

  async getDocument(sessionId, depth) {
    const session = this.getSession(sessionId);
    const requestedDepth = normalizeRequestedDepth(depth);
    const result = await this.send("script.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        requestedDepth: ${JSON.stringify(requestedDepth)},
        outerHTML: document.documentElement ? document.documentElement.outerHTML : null
      })`,
      target: {
        context: session.target.targetId,
      },
      awaitPromise: true,
      resultOwnership: "none",
      serializationOptions: {
        maxObjectDepth: 1,
        maxDomDepth: 0,
      },
      userActivation: false,
    });

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

  async takeScreenshot(sessionId, format) {
    const session = this.getSession(sessionId);
    return this.send("browsingContext.captureScreenshot", {
      context: session.target.targetId,
      format: screenshotFormat(format),
    });
  }

  getConsoleMessages(sessionId, limit) {
    return this.getSession(sessionId).getConsoleMessages(limit);
  }

  getNetworkRequests(sessionId, limit) {
    return this.getSession(sessionId).getNetworkRequests(limit);
  }

  async inspectElement(sessionId, selector) {
    const session = this.getSession(sessionId);
    const result = await this.send("script.evaluate", {
      expression: `(() => {
        const selector = ${JSON.stringify(selector)};
        const element = document.querySelector(selector);
        if (!element) {
          return JSON.stringify({
            browserFamily: "firefox",
            selector,
            found: false
          });
        }

        const attributes = Object.fromEntries(
          Array.from(element.attributes, (attribute) => [attribute.name, attribute.value])
        );

        return JSON.stringify({
          browserFamily: "firefox",
          selector,
          found: true,
          node: {
            tagName: element.tagName,
            id: element.getAttribute("id"),
            className: element.getAttribute("class"),
            childElementCount: element.childElementCount,
            attributes,
            textContent: element.textContent,
            innerText: typeof element.innerText === "string" ? element.innerText : null,
            outerHTML: element.outerHTML
          }
        });
      })()`,
      target: {
        context: session.target.targetId,
      },
      awaitPromise: true,
      resultOwnership: "none",
      serializationOptions: {
        maxObjectDepth: 1,
        maxDomDepth: 0,
      },
      userActivation: false,
    });

    if (result.type !== "success") {
      return {
        browserFamily: "firefox",
        selector,
        found: false,
        exceptionDetails: result.exceptionDetails ?? null,
      };
    }

    const payload = summarizeBidiRemoteValue(result.result);
    return JSON.parse(payload);
  }

  getEvents(sessionId, limit) {
    return this.getSession(sessionId).getEvents(limit);
  }

  async closeAll() {
    await Promise.allSettled(
      Array.from(this.sessions.keys(), (sessionId) => this.detachSession(sessionId)),
    );

    if (this.websocket && this.websocket.readyState < WebSocket.CLOSING) {
      this.websocket.close();
    }

    this.sessions.clear();
  }
}
