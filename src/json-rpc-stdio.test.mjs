import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeMessage,
  MAX_MESSAGE_BYTES,
  MessageBuffer,
} from "./json-rpc-stdio.mjs";

test("MessageBuffer decodes framed JSON-RPC messages", () => {
  const buffer = new MessageBuffer();
  const message = { jsonrpc: "2.0", id: 1, method: "ping" };
  const framed = encodeMessage(message);

  const head = framed.subarray(0, 10);
  const tail = framed.subarray(10);

  assert.deepEqual(buffer.push(head), []);
  assert.deepEqual(buffer.push(tail), [message]);
});

test("MessageBuffer decodes multiple frames in one chunk", () => {
  const buffer = new MessageBuffer();
  const first = { jsonrpc: "2.0", id: 1, method: "ping" };
  const second = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const framed = Buffer.concat([encodeMessage(first), encodeMessage(second)]);

  assert.deepEqual(buffer.push(framed), [first, second]);
});

test("MessageBuffer recovers after a malformed frame", () => {
  const buffer = new MessageBuffer();

  assert.throws(
    () => buffer.push("X-Test: 1\r\n\r\n{}"),
    /Missing Content-Length/,
  );
  assert.deepEqual(
    buffer.push(encodeMessage({ jsonrpc: "2.0", id: 3, method: "ping" })),
    [{ jsonrpc: "2.0", id: 3, method: "ping" }],
  );
});

test("MessageBuffer rejects oversized messages", () => {
  const buffer = new MessageBuffer();
  const frame = `Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n{}`;

  assert.throws(() => buffer.push(frame), /maximum size/);
});
