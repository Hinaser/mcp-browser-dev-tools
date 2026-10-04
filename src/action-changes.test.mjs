import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangeTracker,
  eventChanges,
  formatChanges,
  settleRequests,
} from "./action-changes.mjs";
import { InFlightRequests } from "./session-events.mjs";
import { bidiResourceType } from "./firefox-bidi-client.mjs";

const T0 = "2026-10-04T00:00:00.000Z";
const T1 = "2026-10-04T00:00:01.000Z";

function request(requestId, url, extra = {}) {
  return {
    kind: "network",
    phase: "request",
    requestId,
    url,
    capturedAt: T1,
    ...extra,
  };
}

function finished(requestId) {
  return { kind: "network", phase: "finished", completed: true, requestId };
}

test("only the action's unfinished document, fetch, and XHR requests hold up a report", () => {
  const requests = new InFlightRequests();
  for (const event of [
    request("old", "https://example.com/old", {
      capturedAt: T0,
      resourceType: "Fetch",
    }),
    request("open", "https://example.com/api/b", { resourceType: "XHR" }),
    request("page", "https://example.com/next", { resourceType: "Document" }),
    request("img", "https://example.com/a.png", { resourceType: "Image" }),
    request("ws", "wss://example.com/live", { resourceType: "WebSocket" }),
    request("sse", "https://example.com/feed", { resourceType: "EventSource" }),
    request("beacon", "https://example.com/b", { resourceType: "Other" }),
    request("ext", "chrome-extension://abc/frame.html", {
      resourceType: "Document",
    }),
    request("ff", "https://example.com/ff", { navigation: "nav-1" }),
    request("unknown", "https://example.com/u"),
  ]) {
    requests.observe(event);
  }

  assert.deepEqual(
    settleRequests(requests.list(), "2026-10-04T00:00:00.500Z"),
    [
      { url: "https://example.com/api/b", document: false },
      { url: "https://example.com/next", document: true },
      { url: "https://example.com/ff", document: true },
      { url: "https://example.com/u", document: false },
    ],
  );
});

test("a burst of images does not push an unfinished fetch out", () => {
  const requests = new InFlightRequests(3);
  requests.observe(
    request("save", "https://example.com/api/save", { resourceType: "Fetch" }),
  );
  for (let index = 0; index < 10; index += 1) {
    requests.observe(
      request(`img${index}`, `https://example.com/${index}.png`, {
        resourceType: "Image",
      }),
    );
  }
  assert.deepEqual(
    requests.list().map((entry) => entry.url),
    ["https://example.com/api/save"],
  );
});

test("InFlightRequests outlives the event buffer and follows redirect hops", () => {
  const requests = new InFlightRequests(3);
  requests.observe(request("save", "https://example.com/api/save"));
  assert.equal(requests.list().length, 1);

  // BiDi completes the 302 hop, then restarts the request under its id.
  requests.observe(finished("save"));
  assert.equal(requests.list().length, 0);
  requests.observe(request("save", "https://example.com/api/saved"));
  assert.deepEqual(requests.list(), [
    {
      url: "https://example.com/api/saved",
      resourceType: null,
      navigation: null,
      startedAt: T1,
    },
  ]);
  requests.observe(finished("save"));
  assert.equal(requests.list().length, 0);

  // Past the limit, the oldest request is dropped.
  for (const id of ["a", "b", "c", "d"]) {
    requests.observe(request(id, `https://example.com/${id}`));
  }
  assert.deepEqual(
    requests.list().map((entry) => entry.url),
    ["https://example.com/b", "https://example.com/c", "https://example.com/d"],
  );
});

test("bidiResourceType names documents, fetches, and XHRs from BiDi request data", () => {
  assert.equal(
    bidiResourceType({ destination: "document", initiatorType: null }),
    "Document",
  );
  assert.equal(
    bidiResourceType({ destination: "iframe", initiatorType: null }),
    "Document",
  );
  assert.equal(
    bidiResourceType({ destination: "", initiatorType: "fetch" }),
    "Fetch",
  );
  assert.equal(
    bidiResourceType({ destination: "", initiatorType: "xmlhttprequest" }),
    "XHR",
  );
  assert.equal(
    bidiResourceType({ destination: "image", initiatorType: "img" }),
    "image",
  );
  // EventSource and beacons come with neither.
  assert.equal(
    bidiResourceType({ destination: "", initiatorType: null }),
    "Other",
  );
  assert.equal(bidiResourceType({ url: "https://example.com" }), null);
});

test("eventChanges lists new errors and dialogs, without favicon misses", () => {
  const events = [
    { kind: "console", level: "error", text: "before", capturedAt: T0 },
    { kind: "console", level: "error", text: "bad thing", capturedAt: T1 },
    { kind: "console", level: "error", text: "bad thing", capturedAt: T1 },
    { kind: "console", level: "warning", text: "meh", capturedAt: T1 },
    {
      kind: "exception",
      text: "Uncaught",
      exception: "TypeError: x is undefined\n    at app.js:1:2",
      capturedAt: T1,
    },
    {
      kind: "log",
      level: "error",
      text: "Failed to load resource: 404",
      url: "https://example.com/favicon.ico",
      capturedAt: T1,
    },
    {
      kind: "dialog",
      phase: "opened",
      dialogType: "alert",
      message: "Saved",
      capturedAt: T1,
    },
    { kind: "dialog", phase: "closed", dialogType: "alert", capturedAt: T1 },
  ];

  assert.deepEqual(eventChanges(events, T1), {
    errors: { items: ["bad thing", "TypeError: x is undefined"], more: 0 },
    dialogs: { items: ["alert: Saved"], more: 0 },
  });
});

const noEvents = {
  errors: { items: [], more: 0 },
  dialogs: { items: [], more: 0 },
};

test("formatChanges leaves out empty lists and says none when nothing changed", () => {
  const empty = { lines: [], more: 0 };
  const report = {
    newDocument: false,
    url: "https://example.com/a",
    title: "A",
    urlChanged: false,
    titleChanged: false,
    added: empty,
    removed: empty,
    updated: empty,
    text: { items: [], more: 0 },
  };
  assert.deepEqual(formatChanges({ report, events: noEvents, pending: [] }), {
    none: true,
  });

  assert.deepEqual(
    formatChanges({
      report: {
        ...report,
        urlChanged: true,
        added: { lines: ['e9 button "Retry"'], more: 2 },
        text: { items: ["Card declined"], more: 0 },
      },
      events: { ...noEvents, errors: { items: ["boom"], more: 0 } },
      pending: [{ url: "https://example.com/api", document: false }],
    }),
    {
      url: "https://example.com/a",
      added: ['e9 button "Retry"'],
      addedMore: 2,
      text: ["Card declined"],
      consoleErrors: ["boom"],
      stillLoading: ["https://example.com/api"],
    },
  );
});

test("formatChanges reports a navigation with the new page's nodes", () => {
  assert.deepEqual(
    formatChanges({
      report: {
        newDocument: true,
        url: "https://example.com/home",
        title: "Home",
        nodes: ['e20 h1 "Welcome"'],
        more: 4,
      },
      events: noEvents,
      pending: [],
    }),
    {
      navigated: true,
      url: "https://example.com/home",
      title: "Home",
      nodes: ['e20 h1 "Welcome"'],
      nodesMore: 4,
    },
  );
});

// A page whose status and report the test scripts; events come from a list
// the test can extend while the tracker polls.
function fakeAdapter({ statuses, report, events = [] }) {
  const calls = [];
  let index = 0;
  return {
    calls,
    events,
    async trackChanges(sessionId, phase, options) {
      calls.push(phase);
      if (phase === "baseline") {
        return { documentId: "d1" };
      }
      if (phase === "stop") {
        return { stopped: true };
      }
      if (phase === "status") {
        const status = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        if (status instanceof Error) {
          throw status;
        }
        return typeof status === "function" ? status(options) : status;
      }
      return report;
    },
    async getEvents() {
      return events;
    },
    // The session's in-flight list, rebuilt from the test's events.
    async pendingRequests() {
      const requests = new InFlightRequests();
      for (const event of events) {
        requests.observe(event);
      }
      return requests.list();
    },
  };
}

const quickTimings = {
  quietMs: 20,
  settleMs: 200,
  navigationMs: 400,
  pollMs: 5,
};

const sameReport = {
  newDocument: false,
  url: "https://example.com/a",
  title: "A",
  added: { lines: [], more: 0 },
  removed: { lines: [], more: 0 },
  updated: { lines: ['e2 checkbox "Digest" checked'], more: 0 },
  text: { items: [], more: 0 },
};

test("ChangeTracker waits for the page's requests before reporting", async () => {
  const adapter = fakeAdapter({
    statuses: [{ document: "same", quietMs: 100 }],
    report: sameReport,
  });
  const tracker = new ChangeTracker(adapter, quickTimings);
  const baseline = await tracker.begin("s1");
  adapter.events.push({
    ...request("save", "https://example.com/api/save"),
    capturedAt: new Date().toISOString(),
  });
  setTimeout(() => adapter.events.push(finished("save")), 60);

  const startedAt = Date.now();
  const changes = await tracker.settle(baseline);
  assert.ok(Date.now() - startedAt >= 55);
  assert.deepEqual(changes, { updated: ['e2 checkbox "Digest" checked'] });
});

test("ChangeTracker waits through a navigation for the new document", async () => {
  const adapter = fakeAdapter({
    statuses: [
      { document: "same", quietMs: 100 },
      new Error("Execution context was destroyed"),
      { document: "new", readyState: "loading", quietMs: 0 },
      { document: "new", readyState: "interactive", quietMs: 0 },
      { document: "new", readyState: "interactive", quietMs: 100 },
    ],
    report: {
      newDocument: true,
      url: "https://example.com/home",
      title: "Home",
      nodes: ['e9 h1 "Home"'],
      more: 0,
    },
  });
  const tracker = new ChangeTracker(adapter, quickTimings);
  const baseline = await tracker.begin("s1");
  adapter.events.push({
    ...request("nav", "https://example.com/home", { resourceType: "Document" }),
    capturedAt: new Date().toISOString(),
  });
  setTimeout(() => adapter.events.push(finished("nav")), 30);

  const changes = await tracker.settle(baseline);
  assert.equal(changes.navigated, true);
  assert.deepEqual(changes.nodes, ['e9 h1 "Home"']);
  assert.equal(changes.stillLoading, undefined);
});

test("ChangeTracker gives up at the settle limit and names what is still loading", async () => {
  const adapter = fakeAdapter({
    statuses: [{ document: "same", quietMs: 100 }],
    report: sameReport,
  });
  const tracker = new ChangeTracker(adapter, quickTimings);
  const baseline = await tracker.begin("s1");
  adapter.events.push({
    ...request("poll", "https://example.com/api/poll"),
    capturedAt: new Date().toISOString(),
  });

  const startedAt = Date.now();
  const changes = await tracker.settle(baseline);
  const waited = Date.now() - startedAt;
  assert.ok(waited >= 195 && waited < 390, `waited ${waited}ms`);
  assert.deepEqual(changes.stillLoading, ["https://example.com/api/poll"]);
});

test("ChangeTracker waits for a new document's own fetches", async () => {
  const adapter = fakeAdapter({
    statuses: [{ document: "new", readyState: "interactive", quietMs: 100 }],
    report: {
      newDocument: true,
      url: "https://example.com/home",
      title: "Home",
      nodes: ['e9 button "Load more"'],
      more: 0,
    },
  });
  const tracker = new ChangeTracker(adapter, quickTimings);
  const baseline = await tracker.begin("s1");
  adapter.events.push({
    ...request("init", "https://example.com/api/init", { resourceType: "XHR" }),
    capturedAt: new Date().toISOString(),
  });
  setTimeout(() => adapter.events.push(finished("init")), 60);

  const startedAt = Date.now();
  const changes = await tracker.settle(baseline);
  assert.ok(Date.now() - startedAt >= 55);
  assert.equal(changes.navigated, true);
});

test("ChangeTracker reports unavailable when the page lost the baseline", async () => {
  const adapter = fakeAdapter({
    statuses: [{ document: "same", lost: true }],
    report: { lost: true, url: "https://example.com/a", title: "A" },
  });
  const tracker = new ChangeTracker(adapter, quickTimings);
  const changes = await tracker.settle(await tracker.begin("s1"));
  assert.deepEqual(changes, { unavailable: true });
});

test("ChangeTracker.around skips the report when the element was not found or no baseline", async () => {
  const adapter = fakeAdapter({
    statuses: [{ document: "same", quietMs: 100 }],
    report: sameReport,
  });
  const tracker = new ChangeTracker(adapter, quickTimings);

  const missing = await tracker.around("s1", async () => ({ found: false }));
  assert.deepEqual(missing, { found: false });
  assert.deepEqual(adapter.calls, ["baseline", "stop"]);

  await assert.rejects(
    tracker.around("s1", async () => {
      throw new Error("covered");
    }),
    /covered/,
  );
  assert.deepEqual(adapter.calls.slice(-2), ["baseline", "stop"]);

  const clicked = await tracker.around("s1", async () => ({ clicked: true }));
  assert.deepEqual(clicked, {
    clicked: true,
    changes: { updated: ['e2 checkbox "Digest" checked'] },
  });

  const blocked = new ChangeTracker(
    {
      trackChanges: async () => {
        throw new Error("navigating");
      },
      getEvents: async () => [],
    },
    quickTimings,
  );
  assert.deepEqual(
    await blocked.around("s1", async () => ({ clicked: true })),
    { clicked: true },
  );
});
