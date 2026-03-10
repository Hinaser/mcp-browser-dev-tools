import { CdpSessionManager } from "./cdp-client.mjs";
import { FirefoxBidiSessionManager } from "./firefox-bidi-client.mjs";

const SUPPORTED_FAMILIES = ["chromium", "firefox"];

function prefixId(browserFamily, value) {
  return `${browserFamily}:${value}`;
}

function resolvePrefixedId(value, kind) {
  if (typeof value !== "string") {
    throw new Error(`${kind} must be a string`);
  }

  for (const browserFamily of SUPPORTED_FAMILIES) {
    const prefix = `${browserFamily}:`;
    if (value.startsWith(prefix)) {
      return {
        browserFamily,
        localId: value.slice(prefix.length),
      };
    }
  }

  throw new Error(
    `${kind} must include a browser prefix (${SUPPORTED_FAMILIES.join(", ")})`,
  );
}

function mapPrefixedFields(value, browserFamily) {
  if (Array.isArray(value)) {
    return value.map((entry) => mapPrefixedFields(entry, browserFamily));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "sessionId" && typeof entry === "string") {
        return [key, prefixId(browserFamily, entry)];
      }

      if (key === "targetId" && typeof entry === "string") {
        return [key, prefixId(browserFamily, entry)];
      }

      return [key, mapPrefixedFields(entry, browserFamily)];
    }),
  );
}

function mergeStatusError(statuses) {
  const failures = Object.entries(statuses)
    .filter(([, status]) => !status.available)
    .map(([browserFamily, status]) => `${browserFamily}: ${status.error}`);

  return failures.length > 0 ? failures.join("; ") : null;
}

export class MultiBrowserAdapter {
  constructor(adapters) {
    this.adapters = adapters;
  }

  getAdapter(browserFamily) {
    const adapter = this.adapters[browserFamily];
    if (!adapter) {
      throw new Error(`Unsupported browser family: ${browserFamily}`);
    }

    return adapter;
  }

  async getBrowserStatus() {
    const entries = await Promise.all(
      Object.entries(this.adapters).map(async ([browserFamily, adapter]) => [
        browserFamily,
        await adapter.getBrowserStatus(),
      ]),
    );
    const browsers = Object.fromEntries(entries);
    const availableBrowsers = Object.entries(browsers)
      .filter(([, status]) => status.available)
      .map(([browserFamily]) => browserFamily);

    return {
      available: availableBrowsers.length > 0,
      browserFamily: "auto",
      sessionCount: Object.values(browsers).reduce(
        (total, status) => total + (status.sessionCount ?? 0),
        0,
      ),
      availableBrowsers,
      browsers,
      error:
        availableBrowsers.length > 0
          ? null
          : (mergeStatusError(browsers) ?? "No browser endpoints available"),
    };
  }

  async listTargets() {
    const results = await Promise.all(
      Object.entries(this.adapters).map(async ([browserFamily, adapter]) => {
        try {
          return (await adapter.listTargets()).map((target) => ({
            ...target,
            browserFamily,
            targetId: prefixId(browserFamily, target.targetId),
          }));
        } catch {
          return [];
        }
      }),
    );

    return results.flat();
  }

  listSessions() {
    return Object.entries(this.adapters).flatMap(([browserFamily, adapter]) =>
      adapter.listSessions().map((session) => ({
        ...session,
        browserFamily,
        sessionId: prefixId(browserFamily, session.sessionId),
        targetId:
          typeof session.targetId === "string"
            ? prefixId(browserFamily, session.targetId)
            : session.targetId,
      })),
    );
  }

  async attachToTarget(targetId) {
    const { browserFamily, localId } = resolvePrefixedId(targetId, "targetId");
    const session =
      await this.getAdapter(browserFamily).attachToTarget(localId);

    return {
      ...session,
      browserFamily,
      sessionId: prefixId(browserFamily, session.sessionId),
      targetId:
        typeof session.targetId === "string"
          ? prefixId(browserFamily, session.targetId)
          : targetId,
    };
  }

  async detachSession(sessionId) {
    const { browserFamily, localId } = resolvePrefixedId(
      sessionId,
      "sessionId",
    );

    return mapPrefixedFields(
      await this.getAdapter(browserFamily).detachSession(localId),
      browserFamily,
    );
  }

  async createTab(url, options = {}) {
    const browserFamily = options.browserFamily;
    if (!browserFamily) {
      throw new Error(
        "browserFamily is required when multiple browsers are configured",
      );
    }

    const result = await this.getAdapter(browserFamily).createTab(url);
    return {
      ...mapPrefixedFields(result, browserFamily),
      browserFamily,
    };
  }

  async closeTarget(targetId) {
    const { browserFamily, localId } = resolvePrefixedId(targetId, "targetId");
    return {
      ...mapPrefixedFields(
        await this.getAdapter(browserFamily).closeTarget(localId),
        browserFamily,
      ),
      browserFamily,
    };
  }

  async delegateSession(sessionId, methodName, args = []) {
    const { browserFamily, localId } = resolvePrefixedId(
      sessionId,
      "sessionId",
    );
    const adapter = this.getAdapter(browserFamily);
    const result = await adapter[methodName](localId, ...args);

    if (result === undefined) {
      return result;
    }

    if (methodName === "getConsoleMessages" || methodName === "getEvents") {
      return mapPrefixedFields(result, browserFamily);
    }

    if (methodName === "getNetworkRequests") {
      return mapPrefixedFields(result, browserFamily);
    }

    return mapPrefixedFields(result, browserFamily);
  }

  getPageState(sessionId) {
    return this.delegateSession(sessionId, "getPageState");
  }

  navigate(sessionId, url, options) {
    return this.delegateSession(sessionId, "navigate", [url, options]);
  }

  reload(sessionId, options) {
    return this.delegateSession(sessionId, "reload", [options]);
  }

  click(sessionId, selector) {
    return this.delegateSession(sessionId, "click", [selector]);
  }

  hover(sessionId, selector) {
    return this.delegateSession(sessionId, "hover", [selector]);
  }

  type(sessionId, selector, text, options) {
    return this.delegateSession(sessionId, "type", [selector, text, options]);
  }

  select(sessionId, selector, options) {
    return this.delegateSession(sessionId, "select", [selector, options]);
  }

  pressKey(sessionId, key, selector) {
    return this.delegateSession(sessionId, "pressKey", [key, selector]);
  }

  scroll(sessionId, options) {
    return this.delegateSession(sessionId, "scroll", [options]);
  }

  setViewport(sessionId, options) {
    return this.delegateSession(sessionId, "setViewport", [options]);
  }

  evaluate(sessionId, expression) {
    return this.delegateSession(sessionId, "evaluate", [expression]);
  }

  getDocument(sessionId, depth) {
    return this.delegateSession(sessionId, "getDocument", [depth]);
  }

  getConsoleMessages(sessionId, limit) {
    return this.delegateSession(sessionId, "getConsoleMessages", [limit]);
  }

  getNetworkRequests(sessionId, limit) {
    return this.delegateSession(sessionId, "getNetworkRequests", [limit]);
  }

  inspectElement(sessionId, selector) {
    return this.delegateSession(sessionId, "inspectElement", [selector]);
  }

  takeScreenshot(sessionId, format, options) {
    return this.delegateSession(sessionId, "takeScreenshot", [format, options]);
  }

  getEvents(sessionId, limit) {
    return this.delegateSession(sessionId, "getEvents", [limit]);
  }

  async closeAll() {
    await Promise.all(
      Object.values(this.adapters).map((adapter) => adapter.closeAll()),
    );
  }
}

export function createBrowserAdapter(config) {
  if (config.browserFamily === "firefox") {
    return new FirefoxBidiSessionManager(config);
  }

  if (config.browserFamily === "auto") {
    return new MultiBrowserAdapter({
      chromium: new CdpSessionManager({
        ...config,
        browserFamily: "chromium",
      }),
      firefox: new FirefoxBidiSessionManager({
        ...config,
        browserFamily: "firefox",
      }),
    });
  }

  if (config.browserFamily === "edge") {
    return new CdpSessionManager(config);
  }

  return new CdpSessionManager(config);
}
