import assert from "node:assert/strict";
import test from "node:test";

import { INPUT_NOT_DELIVERED, sendCheckedInput } from "./input-delivery.mjs";

const dropped = { delivered: false, conclusive: true };

function probeReadings(readings) {
  const calls = [];
  return {
    calls,
    readProbe: async (disarm) => {
      calls.push(disarm);
      return readings.length > 1 ? readings.shift() : readings[0];
    },
  };
}

function counter() {
  const steps = [];
  return {
    steps,
    send: async () => {
      steps.push("send");
    },
    recover: async () => {
      steps.push("recover");
    },
  };
}

test("sendCheckedInput sends once when the page receives the input", async () => {
  const run = counter();
  const probe = probeReadings([
    { delivered: true, events: ["click"], node: { id: "a" } },
  ]);

  const result = await sendCheckedInput({
    ...run,
    readProbe: probe.readProbe,
    describe: "The click",
  });

  assert.deepEqual(run.steps, ["send"]);
  assert.deepEqual(result, { node: { id: "a" }, resent: false });
  assert.deepEqual(probe.calls, [false]);
});

test("sendCheckedInput waits for input that arrives late before resending", async () => {
  const run = counter();
  const probe = probeReadings([
    dropped,
    dropped,
    { delivered: true, events: [], node: null },
  ]);

  const result = await sendCheckedInput({
    ...run,
    readProbe: probe.readProbe,
    describe: "The click",
  });

  assert.deepEqual(run.steps, ["send"]);
  assert.equal(result.resent, false);
  assert.deepEqual(probe.calls, [false, false, false]);
});

test("sendCheckedInput does not resend when the probe cannot be sure", async () => {
  const run = counter();
  const probe = probeReadings([{ delivered: false, conclusive: false }]);

  await assert.rejects(
    sendCheckedInput({
      ...run,
      readProbe: probe.readProbe,
      describe: 'The key press "Enter"',
    }),
    {
      code: INPUT_NOT_DELIVERED,
      message:
        /^The key press "Enter" was sent, but no input events reached the page, so it most likely had no effect\. It was not sent again/,
    },
  );
  assert.deepEqual(run.steps, ["send"]);
  assert.deepEqual(probe.calls, [false, false, false, true]);
});

test("sendCheckedInput treats an unreadable probe as delivered", async () => {
  const run = counter();
  const probe = probeReadings([null]);

  const result = await sendCheckedInput({
    ...run,
    readProbe: probe.readProbe,
    describe: "The click",
  });

  assert.deepEqual(result, { node: null, resent: false });
  assert.deepEqual(run.steps, ["send"]);
});

test("sendCheckedInput does not resend input that arrived during recovery", async () => {
  for (const afterRecovery of [{ delivered: true, events: ["click"] }, null]) {
    const run = counter();
    const probe = probeReadings([dropped, dropped, dropped, afterRecovery]);

    const result = await sendCheckedInput({
      ...run,
      readProbe: probe.readProbe,
      describe: "The click",
    });

    assert.deepEqual(run.steps, ["send", "recover"]);
    assert.equal(result.resent, false);
  }
});

test("sendCheckedInput resends once after recovery", async () => {
  const run = counter();
  const probe = probeReadings([
    dropped,
    dropped,
    dropped,
    dropped,
    { delivered: true, events: ["click"] },
  ]);

  const result = await sendCheckedInput({
    ...run,
    readProbe: probe.readProbe,
    describe: "The click",
  });

  assert.deepEqual(run.steps, ["send", "recover", "send"]);
  assert.equal(result.resent, true);
});

test("sendCheckedInput fails and removes the probe if input never arrives", async () => {
  const run = counter();
  const probe = probeReadings([dropped]);

  await assert.rejects(
    sendCheckedInput({
      ...run,
      readProbe: probe.readProbe,
      describe: 'The click on "#save"',
    }),
    (error) => {
      assert.equal(error.code, INPUT_NOT_DELIVERED);
      assert.match(error.message, /^The click on "#save" was sent twice/);
      assert.match(error.message, /evaluate_js/);
      return true;
    },
  );
  assert.deepEqual(run.steps, ["send", "recover", "send"]);
  assert.equal(probe.calls.at(-1), true);
  assert.equal(probe.calls.filter(Boolean).length, 1);
});

test("sendCheckedInput removes the probe when sending fails", async () => {
  const probe = probeReadings([dropped]);

  await assert.rejects(
    sendCheckedInput({
      send: async () => {
        throw new Error("socket closed");
      },
      readProbe: probe.readProbe,
      describe: "The click",
    }),
    /socket closed/,
  );
  assert.deepEqual(probe.calls, [true]);
});
