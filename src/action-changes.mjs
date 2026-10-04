// Actions (click, type, select, press_key, hover, and run_steps batches that
// contain them) report what they changed, so an agent can confirm the result
// without reading the page again. The page records a baseline of its visible
// headings and controls before the action; afterwards the server waits for
// the page to settle and asks for the difference.

// The page has settled when its DOM has been quiet this long and the requests
// the action started have finished.
export const CHANGE_QUIET_MS = 150;
// Most time to wait for that on the same document.
export const CHANGE_SETTLE_MS = 2000;
// Most time to wait while a navigation the action started loads.
export const CHANGE_NAVIGATION_MS = 10_000;
const CHANGE_POLL_MS = 50;
const NEW_PAGE_NODES = 40;
const EVENT_SCAN_LIMIT = 1000;
const MESSAGE_LIMIT = 5;
const MESSAGE_CHARS = 200;
export const CHANGE_REPORTING_TOOLS = new Set([
  "click",
  "drag",
  "hover",
  "type",
  "select",
  "press_key",
]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clip(text, limit = MESSAGE_CHARS) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function since(events, startedAt) {
  return events.filter((event) => (event?.capturedAt ?? "") >= startedAt);
}

// The unfinished requests the action started, from the session's in-flight
// list, which holds only the http(s) document, fetch, and XHR requests a
// page's result depends on. A pending document request means a navigation
// is under way.
export function settleRequests(requests, startedAt) {
  return requests
    .filter((request) => (request.startedAt ?? "") >= startedAt)
    .map((request) => ({
      url: request.url,
      document:
        String(request.resourceType ?? "").toLowerCase() === "document" ||
        Boolean(request.navigation),
    }));
}

function errorText(event) {
  if (event.kind === "exception") {
    const description =
      typeof event.exception === "string" ? event.exception : null;
    return description ? description.split("\n")[0] : event.text;
  }
  return event.text;
}

// Repeats (a reconnecting EventSource, a retried request) appear once.
function capMessages(messages) {
  const unique = Array.from(new Set(messages.map((message) => clip(message))));
  return {
    items: unique.slice(0, MESSAGE_LIMIT),
    more: Math.max(0, unique.length - MESSAGE_LIMIT),
  };
}

// A missing favicon is logged as an error on most pages a navigation opens.
function isFaviconError(event) {
  return /\/favicon\.ico(?:[?#]|$)/i.test(event.url ?? "");
}

// Console errors, uncaught exceptions, and dialogs since startedAt.
export function eventChanges(events, startedAt) {
  const recent = since(events, startedAt);
  const errors = recent
    .filter(
      (event) =>
        event.kind === "exception" ||
        ((event.kind === "console" || event.kind === "log") &&
          event.level === "error" &&
          !isFaviconError(event)),
    )
    .map(errorText);
  const dialogs = recent
    .filter((event) => event.kind === "dialog" && event.phase === "opened")
    .map((event) => `${event.dialogType ?? "dialog"}: ${event.message ?? ""}`);
  return { errors: capMessages(errors), dialogs: capMessages(dialogs) };
}

function addList(changes, key, list) {
  if (list?.items?.length > 0 || list?.lines?.length > 0) {
    changes[key] = list.items ?? list.lines;
  }
  if (list?.more > 0) {
    changes[`${key}More`] = list.more;
  }
}

// Shapes the page's report, the events, and anything still loading into the
// changes field. Lists that are empty are left out; { none: true } says the
// action changed nothing the report covers.
export function formatChanges({ report, events, pending }) {
  const changes = {};
  if (report?.newDocument) {
    changes.navigated = true;
    changes.url = report.url;
    changes.title = report.title;
    changes.nodes = report.nodes;
    if (report.more > 0) {
      changes.nodesMore = report.more;
    }
  } else if (report && !report.lost) {
    if (report.urlChanged) {
      changes.url = report.url;
    }
    if (report.titleChanged) {
      changes.title = report.title;
    }
    addList(changes, "added", report.added);
    addList(changes, "removed", report.removed);
    addList(changes, "updated", report.updated);
    addList(changes, "text", report.text);
  } else {
    changes.unavailable = true;
  }
  addList(changes, "consoleErrors", events.errors);
  addList(changes, "dialogs", events.dialogs);
  if (pending.length > 0) {
    changes.stillLoading = pending.slice(0, 3).map((request) => request.url);
  }
  return Object.keys(changes).length > 0 ? changes : { none: true };
}

export class ChangeTracker {
  constructor(browserAdapter, options = {}) {
    this.browserAdapter = browserAdapter;
    // The page drops baselines this server no longer tracks (an action
    // that ended without a report) when the next one is taken, so the
    // tracker names itself and its baselines in progress for each session.
    this.owner = crypto.randomUUID();
    this.active = new Map();
    this.quietMs = options.quietMs ?? CHANGE_QUIET_MS;
    this.settleMs = options.settleMs ?? CHANGE_SETTLE_MS;
    this.navigationMs = options.navigationMs ?? CHANGE_NAVIGATION_MS;
    this.pollMs = options.pollMs ?? CHANGE_POLL_MS;
  }

  activeIds(sessionId) {
    if (!this.active.has(sessionId)) {
      this.active.set(sessionId, new Set());
    }
    return this.active.get(sessionId);
  }

  finish(baseline) {
    const ids = this.active.get(baseline.sessionId);
    ids?.delete(baseline.changeId);
    if (ids?.size === 0) {
      this.active.delete(baseline.sessionId);
    }
  }

  // Records the baseline. Returns null when the page cannot take one (it is
  // mid-navigation, or blocks scripts), and the action then reports nothing.
  async begin(sessionId) {
    const changeId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const active = this.activeIds(sessionId);
    active.add(changeId);
    try {
      const { documentId } = await this.browserAdapter.trackChanges(
        sessionId,
        "baseline",
        { changeId, owner: this.owner, active: Array.from(active) },
      );
      return { sessionId, changeId, documentId, startedAt };
    } catch {
      this.finish({ sessionId, changeId });
      return null;
    }
  }

  // Ends tracking without a report, for an action that failed.
  async stop(baseline) {
    const { sessionId, changeId, documentId } = baseline;
    this.finish(baseline);
    await this.browserAdapter
      .trackChanges(sessionId, "stop", { changeId, documentId })
      .catch(() => {});
  }

  async pending(sessionId, startedAt) {
    try {
      return settleRequests(
        (await this.browserAdapter.pendingRequests(sessionId)) ?? [],
        startedAt,
      );
    } catch {
      return [];
    }
  }

  async events(sessionId) {
    try {
      return (
        (await this.browserAdapter.getEvents(sessionId, EVENT_SCAN_LIMIT)) ?? []
      );
    } catch {
      return [];
    }
  }

  // Waits until the DOM is quiet and the action's requests are done, or a
  // navigation it started has loaded, within the settle and navigation
  // limits; then asks the page for the report.
  async settle(baseline) {
    const { sessionId, changeId, documentId, startedAt } = baseline;
    const ids = { changeId, documentId, owner: this.owner };
    const actionEndedAt = Date.now();
    let pending;
    let timedOut = false;
    while (true) {
      const elapsed = Date.now() - actionEndedAt;
      pending = await this.pending(sessionId, startedAt);
      let status;
      try {
        status = await this.browserAdapter.trackChanges(
          sessionId,
          "status",
          ids,
        );
      } catch {
        // The old document is going away and the new one is not ready.
        status = { document: "unavailable" };
      }
      if (status.lost) {
        break;
      }

      // A new document has settled like the old one would: its DOM quiet
      // and its own fetches done.
      const loadingDocument = pending.some((request) => request.document);
      const quiet =
        elapsed >= this.quietMs &&
        status.quietMs >= this.quietMs &&
        pending.length === 0;
      if (
        status.document === "new" &&
        status.readyState !== "loading" &&
        quiet
      ) {
        break;
      }
      const navigating = status.document !== "same" || loadingDocument;
      if (!navigating && quiet) {
        break;
      }
      if (elapsed >= (navigating ? this.navigationMs : this.settleMs)) {
        timedOut = true;
        break;
      }
      await sleep(this.pollMs);
    }

    let report;
    try {
      report = await this.browserAdapter.trackChanges(sessionId, "report", {
        ...ids,
        limit: NEW_PAGE_NODES,
      });
    } catch {
      report = null;
    } finally {
      this.finish(baseline);
    }
    return formatChanges({
      report,
      events: eventChanges(await this.events(sessionId), startedAt),
      pending: timedOut ? pending : [],
    });
  }

  // Runs action between a baseline and a report, and adds the report to its
  // result as changes. An action that throws, or whose element was not
  // found, ends tracking and returns as it would without it.
  async around(sessionId, action) {
    const baseline = await this.begin(sessionId);
    let result;
    try {
      result = await action();
    } catch (error) {
      if (baseline) {
        await this.stop(baseline);
      }
      throw error;
    }
    if (!baseline) {
      return result;
    }
    if (!result || typeof result !== "object" || result.found === false) {
      await this.stop(baseline);
      return result;
    }
    return { ...result, changes: await this.settle(baseline) };
  }
}
