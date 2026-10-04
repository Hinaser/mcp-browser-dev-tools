import test from "node:test";

import assert from "node:assert/strict";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import {
  callRunSteps,
  callTool,
  createBranchingManager,
  createFakeManager,
  createPaymentManager,
} from "./mcp-test-support.mjs";

test("run_steps runs steps in order and returns screenshots as images", async () => {
  const manager = createFakeManager();
  const calls = [];
  const originalClick = manager.click;
  manager.click = async (...args) => {
    calls.push("click");
    return originalClick.apply(manager, args);
  };
  manager.takeScreenshot = async (sessionId, format) => {
    calls.push("take_screenshot");
    return {
      sessionId,
      format,
      mimeType: "image/png",
      encoding: "base64",
      data: "ZmFrZQ==",
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "text=Save" } },
      { tool: "sleep", arguments: { ms: 1 } },
      { tool: "take_screenshot" },
    ],
  });

  const value = response.result.structuredContent;
  assert.deepEqual(calls, ["click", "take_screenshot"]);
  assert.equal(value.ok, true);
  assert.equal(value.ranSteps, 3);
  assert.equal(value.steps[0].result.selector, "text=Save");
  assert.deepEqual(value.steps[1].result, { sleptMs: 1 });
  assert.equal(value.steps[2].result.image, 1);
  assert.equal(value.steps[2].result.data, undefined);
  assert.deepEqual(response.result.content[1], {
    type: "image",
    data: "ZmFrZQ==",
    mimeType: "image/png",
  });
  assert.doesNotMatch(response.result.content[0].text, /ZmFrZQ==/);
});

test("run_steps stops at the first failing step unless continueOnError", async () => {
  const manager = createFakeManager();
  manager.click = async () => {
    throw new Error("element is covered");
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const steps = [
    { tool: "click", arguments: { selector: "#save" } },
    { tool: "get_page_state" },
  ];

  const stopped = (
    await callRunSteps(server, { sessionId: "session-1", steps })
  ).result.structuredContent;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.ranSteps, 1);
  assert.equal(stopped.skippedSteps, 1);
  assert.equal(stopped.steps[0].error, "element is covered");

  const continued = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps,
      continueOnError: true,
    })
  ).result.structuredContent;
  assert.equal(continued.ok, false);
  assert.equal(continued.ranSteps, 2);
  assert.equal(continued.steps[1].ok, true);
});

test("run_steps validates every step before running any", async () => {
  const manager = createFakeManager();
  let clicked = false;
  manager.click = async () => {
    clicked = true;
    return {};
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const badArgs = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "#save" } },
      { tool: "wait_for", arguments: { timeoutMs: "1000" } },
    ],
  });
  assert.match(
    badArgs.error.message,
    /arguments\.steps\[1\]\.arguments\.timeoutMs must be an integer/,
  );

  const sessionOverride = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [{ tool: "click", arguments: { sessionId: "x", selector: "#a" } }],
  });
  assert.match(sessionOverride.error.message, /sessionId is not allowed/);

  const longSleep = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [{ tool: "sleep", arguments: { ms: 60_000 } }],
  });
  assert.match(longSleep.error.message, /ms must be <= 30000/);

  const missingCondition = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "#save" } },
      { tool: "wait_for" },
    ],
  });
  assert.match(missingCondition.error.message, /wait_for requires at least/);

  const notSessionTool = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [{ tool: "launch_browser" }],
  });
  assert.match(notSessionTool.error.message, /tool must be one of/);

  const unknownKey = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      { tool: "click", arguments: { selector: "#save" } },
      { tool: "press_key", arguments: { key: "Hyper+Enter" } },
    ],
  });
  assert.match(unknownKey.error.message, /Unsupported modifier "Hyper"/);

  assert.equal(clicked, false);
});

test("run_steps treats a missing element as a failed step, except for inspect_element", async () => {
  const manager = createFakeManager();
  const clicked = [];
  manager.click = async (sessionId, selector) => {
    clicked.push(selector);
    return { selector, found: selector !== "#missing" };
  };
  manager.inspectElement = async (sessionId, selector) => ({
    selector,
    found: false,
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const missingClick = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        { tool: "click", arguments: { selector: "#missing", timeoutMs: 0 } },
        { tool: "click", arguments: { selector: "#submit" } },
      ],
    })
  ).result.structuredContent;
  assert.deepEqual(clicked, ["#missing"]);
  assert.equal(missingClick.ok, false);
  assert.equal(
    missingClick.steps[0].error,
    "No element matches selector #missing",
  );
  assert.equal(missingClick.steps[0].result.found, false);

  const absenceCheck = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [{ tool: "inspect_element", arguments: { selector: "#gone" } }],
    })
  ).result.structuredContent;
  assert.equal(absenceCheck.ok, true);
});

test("run_steps if runs the then branch when the condition holds", async () => {
  const { manager, calls } = createBranchingManager({
    "text=Accept cookies": { innerText: "Accept cookies" },
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "text=Accept cookies" },
            then: [
              { tool: "click", arguments: { selector: "text=Accept cookies" } },
            ],
            else: [{ tool: "click", arguments: { selector: "#other" } }],
          },
        },
        { tool: "click", arguments: { selector: "#next" } },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click text=Accept cookies", "click #next"]);
  assert.equal(value.ok, true);
  assert.equal(value.steps[0].result.matched, true);
  assert.equal(value.steps[0].result.branch, "then");
  assert.deepEqual(value.steps[0].result.checked, [
    { branch: "then", matched: true, observed: { found: true, visible: true } },
  ]);
  assert.equal(value.steps[0].result.steps[0].tool, "click");
});

test("run_steps if runs the first matching elseIf without nesting", async () => {
  const { manager, calls } = createBranchingManager({
    "#status": { innerText: "Payment failed: card declined" },
  });
  const inspected = [];
  const inspect = manager.inspectElement;
  manager.inspectElement = async (sessionId, selector) => {
    inspected.push(selector);
    return inspect(sessionId, selector);
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "#status", textEquals: "Paid" },
            then: [{ tool: "click", arguments: { selector: "#receipt" } }],
            elseIf: [
              {
                condition: { selector: "#status", textIncludes: "failed" },
                then: [{ tool: "click", arguments: { selector: "#retry" } }],
              },
              {
                condition: { selector: "#banner" },
                then: [{ tool: "click", arguments: { selector: "#banner" } }],
              },
            ],
            else: [{ tool: "click", arguments: { selector: "#fallback" } }],
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #retry"]);
  assert.deepEqual(inspected, ["#status", "#status"]);
  const result = value.steps[0].result;
  assert.equal(result.branch, "elseIf[0]");
  assert.equal(result.matched, true);
  assert.deepEqual(
    result.checked.map((check) => [check.branch, check.matched]),
    [
      ["then", false],
      ["elseIf[0]", true],
    ],
  );
  assert.equal(
    result.checked[1].observed.text,
    "Payment failed: card declined",
  );
});

test("run_steps if runs else when no condition holds", async () => {
  const { manager, calls } = createBranchingManager({});
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const result = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "#a" },
            elseIf: [{ condition: { selector: "#b" } }],
            else: [{ tool: "click", arguments: { selector: "#fallback" } }],
          },
        },
      ],
    })
  ).result.structuredContent.steps[0].result;

  assert.deepEqual(calls, ["click #fallback"]);
  assert.equal(result.matched, false);
  assert.equal(result.branch, "else");
  assert.equal(result.checked.length, 2);
});

test("run_steps if with no matching branch runs nothing and succeeds", async () => {
  const { manager, calls } = createBranchingManager({});
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { urlIncludes: "/login" },
            then: [{ tool: "click", arguments: { selector: "#login" } }],
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, []);
  assert.equal(value.ok, true);
  assert.equal(value.steps[0].result.branch, "else");
  assert.deepEqual(value.steps[0].result.steps, []);
  assert.equal(
    value.steps[0].result.checked[0].observed.url,
    "https://example.com/dashboard",
  );
});

test("run_steps stops the whole batch when a step inside a branch fails", async () => {
  const { manager, calls } = createBranchingManager({ "#open": {} });
  manager.click = async (sessionId, selector) => {
    calls.push(`click ${selector}`);
    return { selector, found: selector !== "#missing" };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { selector: "#open", state: "present" },
            then: [
              {
                tool: "click",
                arguments: { selector: "#missing", timeoutMs: 0 },
              },
              { tool: "click", arguments: { selector: "#inside" } },
            ],
          },
        },
        { tool: "click", arguments: { selector: "#after" } },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #missing"]);
  assert.equal(value.ok, false);
  assert.equal(value.steps[0].ok, false);
  assert.equal(value.skippedSteps, 1);
});

test("run_steps validates both if branches and limits before running", async () => {
  const { manager, calls } = createBranchingManager({});
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const run = (steps) =>
    callRunSteps(server, { sessionId: "session-1", steps });
  const click = { tool: "click", arguments: { selector: "#a" } };
  const nest = (depth) =>
    depth === 0
      ? click
      : {
          tool: "if",
          arguments: { condition: { url: "x" }, then: [nest(depth - 1)] },
        };

  const badElse = await run([
    click,
    {
      tool: "if",
      arguments: {
        condition: { selector: "#a" },
        then: [],
        else: [{ tool: "scroll" }],
      },
    },
  ]);
  assert.match(badElse.error.message, /scroll requires either selector/);

  const badCondition = await run([
    { tool: "if", arguments: { condition: { state: "visible" } } },
  ]);
  assert.match(
    badCondition.error.message,
    /arguments\.steps\[0\]\.arguments\.condition requires at least one/,
  );

  const badElseIf = await run([
    {
      tool: "if",
      arguments: {
        condition: { selector: "#a" },
        elseIf: [
          { condition: { selector: "#b" }, then: [click] },
          {
            condition: { url: "x" },
            then: [{ tool: "select", arguments: { selector: "#s" } }],
          },
        ],
      },
    },
  ]);
  assert.match(
    badElseIf.error.message,
    /select requires either value or label/,
  );

  const elseIfWithoutCondition = await run([
    {
      tool: "if",
      arguments: { condition: { selector: "#a" }, elseIf: [{ then: [] }] },
    },
  ]);
  assert.match(
    elseIfWithoutCondition.error.message,
    /elseIf\[0\]\.condition is required/,
  );

  const unknownField = await run([
    { tool: "if", arguments: { condition: { selector: "#a", timeoutMs: 5 } } },
  ]);
  assert.match(unknownField.error.message, /timeoutMs is not allowed/);

  const badKeyInElse = await run([
    click,
    {
      tool: "if",
      arguments: {
        condition: { selector: "#a" },
        then: [],
        else: [{ tool: "press_key", arguments: { key: "Enterr" } }],
      },
    },
  ]);
  assert.match(badKeyInElse.error.message, /Unsupported key "Enterr"/);

  assert.equal((await run([nest(4)])).result.structuredContent.ok, true);
  assert.match((await run([nest(5)])).error.message, /deeper than 4 levels/);

  const tooMany = await run([
    {
      tool: "if",
      arguments: {
        condition: { url: "x" },
        then: Array.from({ length: 50 }, () => click),
      },
    },
  ]);
  assert.match(tooMany.error.message, /at most 50 steps/);

  assert.equal(calls.length, 0);
});

test("run_steps repeat runs its steps until the until condition holds", async () => {
  const { manager, calls } = createPaymentManager(3);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "repeat",
          arguments: {
            steps: [{ tool: "click", arguments: { selector: "#pay" } }],
            until: { selector: "#status", textIncludes: "Paid" },
          },
        },
        { tool: "click", arguments: { selector: "#next" } },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, [
    "click #pay",
    "click #pay",
    "click #pay",
    "click #next",
  ]);
  assert.equal(value.ok, true);
  const repeat = value.steps[0].result;
  assert.equal(repeat.matched, true);
  assert.equal(repeat.passes, 3);
  assert.equal(repeat.max, 5);
  assert.equal(repeat.runs.length, 3);
  assert.deepEqual(repeat.runs[0].until, {
    matched: false,
    observed: { found: true, visible: true, text: "Declined" },
  });
  assert.equal(repeat.runs[2].until.matched, true);
});

test("run_steps repeat fails when until never holds within max passes", async () => {
  const { manager, calls } = createPaymentManager(99);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "repeat",
          arguments: {
            max: 2,
            steps: [{ tool: "click", arguments: { selector: "#pay" } }],
            until: { selector: "#status", textIncludes: "Paid" },
          },
        },
        { tool: "click", arguments: { selector: "#next" } },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #pay", "click #pay"]);
  assert.equal(value.ok, false);
  assert.equal(value.ranSteps, 1);
  assert.equal(value.steps[0].error, "until did not hold after 2 passes");
  assert.equal(value.steps[0].result.passes, 2);
});

test("run_steps repeat stops at a failing step without checking until", async () => {
  const { manager, calls } = createPaymentManager(1);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "repeat",
          arguments: {
            steps: [
              {
                tool: "click",
                arguments: { selector: "#missing", timeoutMs: 0 },
              },
              { tool: "click", arguments: { selector: "#pay" } },
            ],
            until: { selector: "#status", textIncludes: "Paid" },
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #missing"]);
  assert.equal(value.ok, false);
  const repeat = value.steps[0].result;
  assert.equal(repeat.passes, 1);
  assert.equal(repeat.runs[0].until, undefined);
});

test("run_steps repeat ends the loop on a failing step even with continueOnError", async () => {
  const { manager, calls } = createPaymentManager(99);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      continueOnError: true,
      steps: [
        {
          tool: "repeat",
          arguments: {
            steps: [
              {
                tool: "if",
                arguments: {
                  condition: { selector: "#status" },
                  then: [
                    {
                      tool: "click",
                      arguments: { selector: "#missing", timeoutMs: 0 },
                    },
                  ],
                },
              },
              { tool: "click", arguments: { selector: "#pay" } },
            ],
            until: { selector: "#status", textIncludes: "Paid" },
          },
        },
        { tool: "click", arguments: { selector: "#next" } },
      ],
    })
  ).result.structuredContent;

  // The rest of the pass and of the batch run, but no second pass.
  assert.deepEqual(calls, ["click #missing", "click #pay", "click #next"]);
  assert.equal(value.ok, false);
  assert.equal(value.steps[0].ok, false);
  assert.equal(value.steps[0].result.passes, 1);
  assert.equal(value.steps[0].result.runs[0].until, undefined);
  assert.equal(value.steps[1].ok, true);
});

test("run_steps repeat keeps earlier passes and images when until fails to check", async () => {
  const { manager } = createPaymentManager(99);
  let checks = 0;
  manager.inspectElement = async (sessionId, selector) => {
    checks += 1;
    if (checks === 2) {
      throw new Error("Session closed");
    }
    return {
      selector,
      found: true,
      node: { visible: true, innerText: "Declined" },
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callRunSteps(server, {
    sessionId: "session-1",
    steps: [
      {
        tool: "repeat",
        arguments: {
          steps: [{ tool: "take_screenshot" }],
          until: { selector: "#status", textIncludes: "Paid" },
        },
      },
    ],
  });
  const value = response.result.structuredContent;

  assert.equal(value.ok, false);
  assert.equal(value.steps[0].error, "until check failed: Session closed");
  const { runs } = value.steps[0].result;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].until.matched, false);
  assert.equal(runs[1].until, undefined);
  assert.deepEqual(
    runs.map((run) => run.steps[0].result.image),
    [1, 2],
  );
  assert.equal(
    response.result.content.filter((block) => block.type === "image").length,
    2,
  );
});

test("run_steps validates repeat steps before running", async () => {
  const { manager, calls } = createPaymentManager(1);
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const run = (steps) =>
    callRunSteps(server, { sessionId: "session-1", steps });
  const click = { tool: "click", arguments: { selector: "#pay" } };
  const until = { selector: "#status", textIncludes: "Paid" };
  const nest = (depth) =>
    depth === 0
      ? click
      : { tool: "repeat", arguments: { steps: [nest(depth - 1)], until } };

  const noUntil = await run([
    click,
    { tool: "repeat", arguments: { steps: [click] } },
  ]);
  assert.match(noUntil.error.message, /arguments\.until is required/);

  const tooMany = await run([
    { tool: "repeat", arguments: { max: 11, steps: [click], until } },
  ]);
  assert.match(tooMany.error.message, /max must be <= 10/);

  const badBody = await run([
    {
      tool: "repeat",
      arguments: {
        steps: [click, { tool: "press_key", arguments: { key: "Enterr" } }],
        until,
      },
    },
  ]);
  assert.match(badBody.error.message, /Unsupported key "Enterr"/);

  const badUntil = await run([
    {
      tool: "repeat",
      arguments: { steps: [click], until: { state: "visible" } },
    },
  ]);
  assert.match(
    badUntil.error.message,
    /arguments\.steps\[0\]\.arguments\.until requires at least one/,
  );

  assert.match((await run([nest(5)])).error.message, /deeper than 4 levels/);

  assert.equal(calls.length, 0);
});

test("run_steps if conditions accept anyOf and report each alternative", async () => {
  const { manager, calls } = createBranchingManager({
    "#status": { innerText: "Declined" },
  });
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: {
              anyOf: [
                { selector: "#status", textIncludes: "Paid" },
                { selector: "#status", textExcludes: "Paid" },
              ],
            },
            then: [{ tool: "click", arguments: { selector: "#retry" } }],
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.deepEqual(calls, ["click #retry"]);
  assert.deepEqual(value.steps[0].result.checked[0].observed, {
    matchedIndex: 1,
    anyOf: [
      { found: true, visible: true, text: "Declined" },
      { found: true, visible: true, text: "Declined" },
    ],
  });
});

test("run_steps if and repeat accept expression conditions", async () => {
  const { manager, calls } = createBranchingManager({});
  let loaded = 0;
  manager.evaluate = async (sessionId, expression) => ({
    result: expression.includes("rows") ? loaded >= 2 : true,
    exceptionDetails: null,
  });
  const click = manager.click;
  manager.click = async (sessionId, selector) => {
    loaded += 1;
    return click(sessionId, selector);
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: {
            condition: { expression: "window.cookieBanner !== undefined" },
            then: [{ tool: "click", arguments: { selector: "#accept" } }],
          },
        },
        {
          tool: "repeat",
          arguments: {
            steps: [{ tool: "click", arguments: { selector: "#more" } }],
            until: { expression: "rows().length >= 2" },
          },
        },
      ],
    })
  ).result.structuredContent;

  assert.equal(value.ok, true);
  assert.deepEqual(calls, ["click #accept", "click #more"]);
  assert.deepEqual(value.steps[0].result.checked, [
    { branch: "then", matched: true, observed: { expression: true } },
  ]);
  assert.equal(value.steps[1].result.matched, true);
  assert.equal(value.steps[1].result.passes, 1);
});

// A manager whose page reports one updated checkbox for every action.
function createChangeReportingManager() {
  const manager = createFakeManager();
  manager.trackCalls = [];
  manager.trackChanges = async (sessionId, phase) => {
    manager.trackCalls.push(phase);
    if (phase === "status") {
      return { document: "same", quietMs: 1000 };
    }
    if (phase === "report") {
      return {
        newDocument: false,
        url: "https://example.com/settings",
        title: "Settings",
        added: { lines: [], more: 0 },
        removed: { lines: [], more: 0 },
        updated: { lines: ['e2 checkbox "Digest" checked'], more: 0 },
        text: { items: ["Saved"], more: 0 },
      };
    }
    return { tracking: true };
  };
  manager.getEvents = async () => [];
  return manager;
}

test("an action reports what it changed on the page", async () => {
  const manager = createChangeReportingManager();
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const response = await callTool(server, "click", {
    sessionId: "session-1",
    selector: "text=Save",
  });

  assert.deepEqual(response.result.structuredContent.changes, {
    updated: ['e2 checkbox "Digest" checked'],
    text: ["Saved"],
  });
  assert.equal(manager.trackCalls[0], "baseline");
  assert.equal(manager.trackCalls.at(-1), "report");
});

test("run_steps reports the batch's changes once, not per step", async () => {
  const manager = createChangeReportingManager();
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [
        { tool: "click", arguments: { selector: "text=Digest" } },
        { tool: "click", arguments: { selector: "text=Save" } },
      ],
    })
  ).result.structuredContent;

  assert.equal(value.ok, true);
  assert.equal(value.steps[0].result.changes, undefined);
  assert.equal(value.steps[1].result.changes, undefined);
  assert.deepEqual(value.changes, {
    updated: ['e2 checkbox "Digest" checked'],
    text: ["Saved"],
  });
  assert.equal(
    manager.trackCalls.filter((phase) => phase === "baseline").length,
    1,
  );
});

test("run_steps without an action takes no baseline", async () => {
  const manager = createChangeReportingManager();
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });

  const value = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [{ tool: "get_page_state" }],
    })
  ).result.structuredContent;

  assert.equal(value.ok, true);
  assert.equal(value.changes, undefined);
  assert.deepEqual(manager.trackCalls, []);
});

test("pointer tools take a selector or x and y, never both or neither", async () => {
  const manager = createFakeManager();
  const calls = [];
  manager.click = async (sessionId, target, options) => {
    calls.push([target, options]);
    return { found: true, clicked: true };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: manager,
  });
  const click = (args) =>
    callTool(server, "click", { sessionId: "s", ...args });

  await click({ x: 10, y: 20, button: "right", clickCount: 2 });
  assert.deepEqual(calls, [
    [
      { x: 10, y: 20 },
      { button: "right", clickCount: 2 },
    ],
  ]);

  for (const [args, message] of [
    [{}, /Pass selector or x and y/],
    [{ selector: "#a", x: 1, y: 2 }, /not both/],
    [{ x: 1 }, /x and y go together/],
  ]) {
    const response = await click(args);
    assert.match(
      response.result?.content?.[0]?.text ?? response.error?.message,
      message,
    );
  }

  const drag = await callTool(server, "drag", {
    sessionId: "s",
    selector: "#a",
  });
  assert.match(
    drag.result?.content?.[0]?.text ?? drag.error?.message,
    /Pass toSelector or toX and toY/,
  );
});
