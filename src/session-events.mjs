const CONSOLE_EVENT_KINDS = new Set(["console", "log", "exception"]);

function normalizeLimit(limit, fallback = 50) {
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
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
