import {
  filterConsoleMessages,
  summarizeNetworkRequests,
} from "./session-events.mjs";

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

function toAttributeObject(attributes = []) {
  const result = {};
  for (let index = 0; index < attributes.length; index += 2) {
    result[attributes[index]] = attributes[index + 1] ?? "";
  }

  return result;
}

function normalizeEvent(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    return {
      kind: "console",
      level: params.type,
      timestamp: params.timestamp,
      values: (params.args || []).map(summarizeRemoteObject),
    };
  }

  if (method === "Runtime.exceptionThrown") {
    return {
      kind: "exception",
      timestamp: params.timestamp,
      text: params.exceptionDetails?.text,
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
    };
  }

  if (method === "Log.entryAdded") {
    return {
      kind: "log",
      level: params.entry?.level,
      text: params.entry?.text,
      url: params.entry?.url,
      timestamp: params.entry?.timestamp,
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
    throw new Error(`CDP endpoint returned ${response.status} ${response.statusText}`);
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
  }

  markClosed() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectPending(new Error("CDP session closed"));
    this.onClosed?.(this);
  }

  async connect() {
    if (!this.target.webSocketDebuggerUrl) {
      throw new Error(`Target ${this.target.targetId} does not expose a debugger websocket`);
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
          reject(new Error(`Failed to connect to ${this.target.webSocketDebuggerUrl}`));
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
    this.bufferedEvents.push({
      method,
      capturedAt: new Date().toISOString(),
      ...normalizeEvent(method, params),
    });

    if (this.bufferedEvents.length > this.eventBufferSize) {
      this.bufferedEvents.shift();
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

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      replMode: true,
    });

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

  async takeScreenshot(format = "png") {
    return this.send("Page.captureScreenshot", { format });
  }

  getConsoleMessages(limit = 50) {
    return filterConsoleMessages(this.bufferedEvents, limit);
  }

  getNetworkRequests(limit = 50) {
    return summarizeNetworkRequests(this.bufferedEvents, limit);
  }

  async inspectElement(selector) {
    const document = await this.getDocument(1);
    const rootNodeId = document.root?.nodeId;
    if (!rootNodeId) {
      throw new Error("Unable to resolve the DOM root node");
    }

    const { nodeId } = await this.send("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    });

    if (!nodeId) {
      return {
        browserFamily: "chromium",
        selector,
        found: false,
      };
    }

    const [description, attributes, outerHtml, textContent] = await Promise.all([
      this.send("DOM.describeNode", {
        nodeId,
        depth: 1,
        pierce: true,
      }),
      this.send("DOM.getAttributes", { nodeId }),
      this.send("DOM.getOuterHTML", { nodeId }),
      this.readNodeText(nodeId),
    ]);

    return {
      browserFamily: "chromium",
      selector,
      found: true,
      node: {
        nodeId,
        backendNodeId: description.node?.backendNodeId ?? null,
        nodeName: description.node?.nodeName ?? null,
        localName: description.node?.localName ?? null,
        nodeType: description.node?.nodeType ?? null,
        childNodeCount: description.node?.childNodeCount ?? 0,
        attributes: toAttributeObject(attributes.attributes),
        textContent: textContent.textContent,
        innerText: textContent.innerText,
        outerHTML: outerHtml.outerHTML ?? null,
      },
    };
  }

  async readNodeText(nodeId) {
    let objectId = null;

    try {
      const resolved = await this.send("DOM.resolveNode", { nodeId });
      objectId = resolved.object?.objectId ?? null;
      if (!objectId) {
        return {
          textContent: null,
          innerText: null,
        };
      }

      const result = await this.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function() { return { textContent: this.textContent ?? null, innerText: typeof this.innerText === 'string' ? this.innerText : null }; }",
        returnByValue: true,
        silent: true,
      });

      return (
        result.result?.value ?? {
          textContent: null,
          innerText: null,
        }
      );
    } catch {
      return {
        textContent: null,
        innerText: null,
      };
    } finally {
      if (objectId) {
        await this.send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
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
      browserFamily: "chromium",
      connectedAt: this.connectedAt,
      bufferedEvents: this.bufferedEvents.length,
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
    return targets.filter((target) => target.type === "page").map(normalizeTarget);
  }

  listSessions() {
    return Array.from(this.sessions.values(), (session) => session.getSummary());
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

  async takeScreenshot(sessionId, format) {
    return this.getSession(sessionId).takeScreenshot(format);
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
