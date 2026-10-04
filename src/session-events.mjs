import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";

const CONSOLE_EVENT_KINDS = new Set(["console", "log", "exception"]);

function normalizeLimit(limit, fallback = 50) {
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
}

const IN_FLIGHT_LIMIT = 500;
// The requests a page's result depends on. Images, scripts, and styles are
// left out, and so are long-lived connections (WebSocket, EventSource) and
// beacons. A request of unknown type (from a Firefox that does not report
// it) is kept.
const IN_FLIGHT_TYPES = new Set(["document", "fetch", "xhr"]);

function dependsOn(event) {
  const type = String(event.resourceType ?? "").toLowerCase();
  return (
    /^https?:/i.test(event.url ?? "") &&
    (!type || IN_FLIGHT_TYPES.has(type) || Boolean(event.navigation))
  );
}

// The http(s) document, fetch, and XHR requests that started and have not
// finished, kept apart from the bounded event buffer so a slow request is
// not forgotten when its start event is evicted. Only these are kept, so a
// burst of images cannot push them out. A redirect hop restarts a request
// under the same id, after BiDi has completed the previous hop. The oldest
// entries are dropped past the limit, since a request whose end is never
// reported would otherwise stay.
export class InFlightRequests {
  constructor(limit = IN_FLIGHT_LIMIT) {
    this.limit = limit;
    this.requests = new Map();
  }

  observe(event) {
    if (event?.kind !== "network" || !event.requestId) {
      return;
    }
    if (event.phase === "request") {
      if (!dependsOn(event)) {
        return;
      }
      const previous = this.requests.get(event.requestId);
      this.requests.delete(event.requestId);
      this.requests.set(event.requestId, {
        url: event.url ?? null,
        resourceType: event.resourceType ?? null,
        navigation: event.navigation ?? null,
        startedAt: previous?.startedAt ?? event.capturedAt ?? null,
      });
      if (this.requests.size > this.limit) {
        this.requests.delete(this.requests.keys().next().value);
      }
    } else if (event.completed) {
      this.requests.delete(event.requestId);
    }
  }

  list() {
    return Array.from(this.requests.values());
  }
}

export function filterConsoleMessages(events = [], limit = 50) {
  const safeLimit = normalizeLimit(limit);
  return events
    .filter((event) => CONSOLE_EVENT_KINDS.has(event.kind))
    .slice(-safeLimit);
}

function createEmptyNetworkRequest(requestId) {
  return {
    requestId,
    url: null,
    method: null,
    resourceType: null,
    initiatorType: null,
    status: null,
    statusText: null,
    mimeType: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    duration: null,
    transferSize: null,
    encodedBodySize: null,
    decodedBodySize: null,
    source: null,
    finished: false,
    failed: false,
    canceled: false,
    errorText: null,
  };
}

export function summarizeNetworkRequests(events = [], limit = 50) {
  const safeLimit = normalizeLimit(limit);
  const requests = new Map();

  for (const event of events) {
    if (event?.kind !== "network") {
      continue;
    }

    const requestId = event.requestId ?? `network-${requests.size + 1}`;
    const timestamp = event.timestamp ?? event.capturedAt ?? null;
    const next = {
      ...createEmptyNetworkRequest(requestId),
      ...(requests.get(requestId) ?? {}),
    };

    next.url = event.url ?? next.url;
    next.method = event.method ?? next.method;
    next.resourceType = event.resourceType ?? next.resourceType;
    next.initiatorType = event.initiatorType ?? next.initiatorType;
    next.status = event.status ?? next.status;
    next.statusText = event.statusText ?? next.statusText;
    next.mimeType = event.mimeType ?? next.mimeType;
    next.duration = event.duration ?? next.duration;
    next.transferSize = event.transferSize ?? next.transferSize;
    next.encodedBodySize = event.encodedBodySize ?? next.encodedBodySize;
    next.decodedBodySize = event.decodedBodySize ?? next.decodedBodySize;
    next.source = event.source ?? next.source;
    next.updatedAt = timestamp ?? next.updatedAt;

    if (event.startedAt !== undefined && event.startedAt !== null) {
      next.startedAt = event.startedAt;
    } else if (!next.startedAt || event.phase === "request") {
      next.startedAt = next.startedAt ?? timestamp;
    }

    if (event.completed) {
      next.completedAt = event.completedAt ?? timestamp ?? next.completedAt;
      next.finished = !event.failed;
    }

    if (event.failed) {
      next.failed = true;
      next.canceled = event.canceled ?? next.canceled;
      next.errorText = event.errorText ?? next.errorText;
    }

    requests.set(requestId, next);
  }

  return Array.from(requests.values()).slice(-safeLimit);
}

function asHarDateTime(value, fallback) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return fallback;
}

export function exportHarLikeSummary(events = [], options = {}) {
  const safeLimit = normalizeLimit(options.limit, 50);
  const exportedAt = new Date().toISOString();
  const page = options.page ?? null;
  const pageId = page ? "page-1" : null;
  const requests = summarizeNetworkRequests(events, safeLimit);

  return {
    log: {
      version: "1.2",
      creator: {
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
      },
      pages: page
        ? [
            {
              startedDateTime: exportedAt,
              id: pageId,
              title: page.title ?? page.url ?? "Attached Page",
              pageTimings: {},
            },
          ]
        : [],
      entries: requests.map((request) => ({
        pageref: pageId,
        startedDateTime: asHarDateTime(request.startedAt, exportedAt),
        time: typeof request.duration === "number" ? request.duration : -1,
        request: {
          method: request.method ?? "GET",
          url: request.url ?? "",
          httpVersion: "unknown",
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: request.encodedBodySize ?? -1,
        },
        response: {
          status: request.status ?? 0,
          statusText: request.statusText ?? "",
          httpVersion: "unknown",
          headers: [],
          content: {
            size: request.decodedBodySize ?? -1,
            mimeType: request.mimeType ?? "application/octet-stream",
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: request.encodedBodySize ?? -1,
          _transferSize: request.transferSize ?? -1,
        },
        cache: {},
        timings: {
          send: -1,
          wait: typeof request.duration === "number" ? request.duration : -1,
          receive: -1,
        },
        _requestId: request.requestId,
        _resourceType: request.resourceType ?? null,
        _initiatorType: request.initiatorType ?? null,
        _source: request.source ?? null,
        _finished: request.finished,
        _failed: request.failed,
        _canceled: request.canceled,
        _errorText: request.errorText ?? null,
      })),
    },
  };
}
