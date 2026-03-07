import test from "node:test";
import assert from "node:assert/strict";

import {
  filterConsoleMessages,
  summarizeNetworkRequests,
} from "./session-events.mjs";

test("filterConsoleMessages keeps only console-shaped events", () => {
  const messages = filterConsoleMessages([
    { kind: "console", text: "log" },
    { kind: "network", requestId: "req-1" },
    { kind: "exception", text: "boom" },
  ]);

  assert.deepEqual(messages, [
    { kind: "console", text: "log" },
    { kind: "exception", text: "boom" },
  ]);
});

test("summarizeNetworkRequests merges request and response events", () => {
  const requests = summarizeNetworkRequests([
    {
      kind: "network",
      phase: "request",
      completed: false,
      requestId: "req-1",
      method: "GET",
      url: "https://example.com/app.js",
      resourceType: "Script",
      timestamp: 1,
    },
    {
      kind: "network",
      phase: "response",
      completed: false,
      requestId: "req-1",
      status: 200,
      statusText: "OK",
      mimeType: "text/javascript",
      timestamp: 2,
    },
    {
      kind: "network",
      phase: "finished",
      completed: true,
      failed: false,
      requestId: "req-1",
      timestamp: 3,
    },
  ]);

  assert.deepEqual(requests, [
    {
      requestId: "req-1",
      url: "https://example.com/app.js",
      method: "GET",
      resourceType: "Script",
      initiatorType: null,
      status: 200,
      statusText: "OK",
      mimeType: "text/javascript",
      startedAt: 1,
      completedAt: 3,
      updatedAt: 3,
      duration: null,
      transferSize: null,
      encodedBodySize: null,
      decodedBodySize: null,
      source: null,
      finished: true,
      failed: false,
      canceled: false,
      errorText: null,
    },
  ]);
});

test("summarizeNetworkRequests keeps performance snapshot metadata", () => {
  const requests = summarizeNetworkRequests([
    {
      kind: "network",
      phase: "snapshot",
      completed: true,
      failed: false,
      requestId: "snapshot-1",
      url: "https://example.com/",
      method: "GET",
      resourceType: "navigation",
      initiatorType: "navigation",
      startedAt: 12,
      completedAt: 42,
      duration: 30,
      transferSize: 1024,
      encodedBodySize: 900,
      decodedBodySize: 2400,
      source: "performance",
      timestamp: 42,
    },
  ]);

  assert.deepEqual(requests, [
    {
      requestId: "snapshot-1",
      url: "https://example.com/",
      method: "GET",
      resourceType: "navigation",
      initiatorType: "navigation",
      status: null,
      statusText: null,
      mimeType: null,
      startedAt: 12,
      completedAt: 42,
      updatedAt: 42,
      duration: 30,
      transferSize: 1024,
      encodedBodySize: 900,
      decodedBodySize: 2400,
      source: "performance",
      finished: true,
      failed: false,
      canceled: false,
      errorText: null,
    },
  ]);
});
