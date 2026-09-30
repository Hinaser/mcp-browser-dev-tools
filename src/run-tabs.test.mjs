import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { callTool, createFakeManager } from "./mcp-test-support.mjs";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// A fake browser whose url tabs each get their own target and session, and
// whose navigation takes navigateMs, so concurrency is observable.
function createTabManager({ navigateMs = 20, pages = {} } = {}) {
  const manager = createFakeManager();
  const log = { opened: [], closed: [], navigated: [], inFlight: 0, peak: 0 };
  let nextId = 1;
  const urls = new Map();
  manager.createTab = async (url, options = {}) => {
    const targetId = `tab-${nextId++}`;
    log.opened.push({ targetId, url, browserFamily: options.browserFamily });
    return { targetId, url };
  };
  manager.attachToTarget = async (targetId) => ({
    sessionId: `session-for-${targetId}`,
    targetId,
  });
  manager.closeTarget = async (targetId) => {
    log.closed.push(targetId);
    return { targetId, closed: true };
  };
  manager.navigate = async (sessionId, url, options) => {
    log.inFlight += 1;
    log.peak = Math.max(log.peak, log.inFlight);
    await delay(pages[url]?.navigateMs ?? navigateMs);
    log.inFlight -= 1;
    log.navigated.push({ sessionId, url, waitUntil: options.waitUntil });
    urls.set(sessionId, url);
    return { sessionId, url };
  };
  manager.readText = async (sessionId, options) => {
    const url = urls.get(sessionId) ?? `attached ${sessionId}`;
    return {
      url,
      source: "body",
      text: `text of ${url}`.slice(0, options.maxChars),
    };
  };
  manager.click = async (sessionId, selector) =>
    pages[urls.get(sessionId)]?.missing === selector
      ? { selector, found: false }
      : { selector, found: true };
  manager.snapshotControls = async (sessionId) => ({
    url: urls.get(sessionId),
    title: "Page",
    controls: [{ role: "button", name: "Retry", locator: "text=Retry" }],
    moreControls: 0,
  });
  return { manager, log };
}

function createServer(manager, env = { MCP_BROWSER_FAMILY: "chromium" }) {
  return new McpBrowserDevToolsServer({
    config: loadConfig(env),
    browserAdapter: manager,
  });
}

const read = { tool: "read_text", arguments: { maxChars: 100 } };

test("run_tabs opens tabs, runs their steps at the same time, and closes them", async () => {
  const { manager, log } = createTabManager({ navigateMs: 40 });
  const server = createServer(manager);
  const startedAt = Date.now();

  const response = await callTool(server, "run_tabs", {
    tabs: [
      { url: "https://a.test/", steps: [read] },
      { url: "https://b.test/", waitUntil: "interactive", steps: [read] },
      { url: "https://c.test/", steps: [read] },
    ],
  });
  const value = response.result.structuredContent;

  assert.equal(value.ok, true);
  assert.ok(Date.now() - startedAt < 110, "tabs ran in parallel");
  assert.equal(log.peak, 3);
  assert.deepEqual(
    value.tabs.map((tab) => tab.steps[0].result.text),
    [
      "text of https://a.test/",
      "text of https://b.test/",
      "text of https://c.test/",
    ],
  );
  assert.deepEqual(
    log.navigated.find(({ url }) => url === "https://b.test/").waitUntil,
    "interactive",
  );
  assert.deepEqual(
    log.opened.map(({ url }) => url),
    ["about:blank", "about:blank", "about:blank"],
  );
  assert.deepEqual([...log.closed].sort(), ["tab-1", "tab-2", "tab-3"]);
  for (const tab of value.tabs) {
    assert.equal(tab.closed, true);
    assert.equal(tab.sessionId, undefined);
  }
});

test("run_tabs runs at most concurrency tabs at once and keeps results in order", async () => {
  const { manager, log } = createTabManager({
    pages: { "https://slow.test/": { navigateMs: 60 } },
  });
  const server = createServer(manager);

  const value = (
    await callTool(server, "run_tabs", {
      concurrency: 2,
      tabs: [
        { url: "https://slow.test/", steps: [read] },
        { url: "https://b.test/", steps: [read] },
        { url: "https://c.test/", steps: [read] },
        { url: "https://d.test/", steps: [read] },
      ],
    })
  ).result.structuredContent;

  assert.equal(log.peak, 2);
  assert.deepEqual(
    value.tabs.map((tab) => [tab.index, tab.url]),
    [
      [0, "https://slow.test/"],
      [1, "https://b.test/"],
      [2, "https://c.test/"],
      [3, "https://d.test/"],
    ],
  );
});

test("run_tabs uses attached sessions as they are and reports them", async () => {
  const { manager, log } = createTabManager();
  const server = createServer(manager);

  const value = (
    await callTool(server, "run_tabs", {
      tabs: [{ sessionId: "session-1", steps: [read] }],
    })
  ).result.structuredContent;

  assert.equal(value.tabs[0].ok, true);
  assert.equal(value.tabs[0].sessionId, "session-1");
  assert.equal(
    value.tabs[0].steps[0].result.text,
    "text of attached session-1",
  );
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.closed, []);
});

test("a failing tab reports its page and does not stop the others", async () => {
  const { manager, log } = createTabManager({
    pages: { "https://b.test/": { missing: "text=Next" } },
  });
  const server = createServer(manager);

  const value = (
    await callTool(server, "run_tabs", {
      tabs: [
        { url: "https://a.test/", steps: [read] },
        {
          url: "https://b.test/",
          steps: [
            { tool: "click", arguments: { selector: "text=Next" } },
            read,
          ],
        },
      ],
    })
  ).result.structuredContent;

  assert.equal(value.ok, false);
  assert.equal(value.tabs[0].ok, true);
  assert.equal(value.tabs[1].ok, false);
  assert.equal(value.tabs[1].ranSteps, 1);
  assert.equal(value.tabs[1].skippedSteps, 1);
  assert.equal(value.tabs[1].page.controls[0].locator, "text=Retry");
  assert.equal(log.closed.length, 2);
});

test("a tab that runs past timeoutMs fails and is closed", async () => {
  const { manager, log } = createTabManager({
    pages: { "https://slow.test/": { navigateMs: 200 } },
  });
  const server = createServer(manager);

  const value = (
    await callTool(server, "run_tabs", {
      timeoutMs: 50,
      tabs: [
        { url: "https://a.test/", steps: [read] },
        { url: "https://slow.test/", steps: [read] },
      ],
    })
  ).result.structuredContent;

  assert.equal(value.tabs[0].ok, true);
  assert.equal(value.tabs[1].ok, false);
  assert.match(value.tabs[1].error, /did not finish within 50ms/);
  assert.equal(value.tabs[1].page, undefined);
  assert.ok(log.closed.includes(value.tabs[1].targetId));
});

test("keepTabs leaves the opened tabs attached and reports their sessions", async () => {
  const { manager, log } = createTabManager();
  const server = createServer(manager);

  const value = (
    await callTool(server, "run_tabs", {
      keepTabs: true,
      tabs: [{ url: "https://a.test/", steps: [read] }],
    })
  ).result.structuredContent;

  assert.equal(value.tabs[0].sessionId, "session-for-tab-1");
  assert.equal(value.tabs[0].targetId, "tab-1");
  assert.equal(value.tabs[0].closed, false);
  assert.deepEqual(log.closed, []);
});

test("run_tabs validates every tab before opening any", async () => {
  for (const [tabs, message] of [
    [[{ steps: [read] }], /tabs\[0\] needs either url or sessionId/],
    [
      [{ url: "https://a.test/", sessionId: "session-1" }],
      /tabs\[0\] needs either url or sessionId/,
    ],
    [
      [
        { url: "https://a.test/", steps: [read] },
        { url: "https://b.test/", steps: [{ tool: "clik" }] },
      ],
      /tabs\[1\]\.steps\[0\]\.tool must be one of/,
    ],
    [
      [{ sessionId: "session-1" }, { sessionId: "session-1" }],
      /already used by another tab/,
    ],
    [
      [{ sessionId: "session-1", waitUntil: "complete" }],
      /waitUntil requires url/,
    ],
  ]) {
    const { manager, log } = createTabManager();
    const response = await callTool(createServer(manager), "run_tabs", {
      tabs,
    });
    assert.match(response.error.message, message);
    assert.deepEqual(log.opened, []);
  }
});

test("run_tabs needs browserFamily for url tabs in auto mode", async () => {
  const { manager, log } = createTabManager();
  const server = createServer(manager, { MCP_BROWSER_FAMILY: "auto" });

  const missing = await callTool(server, "run_tabs", {
    tabs: [{ url: "https://a.test/" }],
  });
  assert.match(missing.error.message, /browserFamily is required/);

  const value = (
    await callTool(server, "run_tabs", {
      browserFamily: "firefox",
      tabs: [{ url: "https://a.test/" }],
    })
  ).result.structuredContent;
  assert.equal(value.ok, true);
  assert.equal(log.opened[0].browserFamily, "firefox");
});

test("screenshots from several tabs come back as numbered images", async () => {
  const { manager } = createTabManager();
  manager.takeScreenshot = async (sessionId) => ({
    format: "png",
    mimeType: "image/png",
    encoding: "base64",
    data: Buffer.from(sessionId).toString("base64"),
  });
  const server = createServer(manager);

  const response = await callTool(server, "run_tabs", {
    tabs: [
      { url: "https://a.test/", steps: [{ tool: "take_screenshot" }] },
      { url: "https://b.test/", steps: [{ tool: "take_screenshot" }] },
    ],
  });
  const images = response.result.content.filter(
    (item) => item.type === "image",
  );
  const value = response.result.structuredContent;

  assert.equal(images.length, 2);
  for (const tab of value.tabs) {
    const image = images[tab.steps[0].result.image - 1];
    assert.equal(
      Buffer.from(image.data, "base64").toString(),
      `session-for-${tab.targetId}`,
    );
  }
});

test("a timed-out tab starts no more steps and reports the ones that ran", async () => {
  const { manager } = createTabManager();
  const clicks = [];
  manager.click = async (sessionId, selector) => {
    clicks.push(selector);
    return { selector, found: true };
  };
  manager.takeScreenshot = async () => {
    await delay(80);
    return { format: "png", mimeType: "image/png", data: "bGF0ZQ==" };
  };
  const server = createServer(manager);
  const startedAt = Date.now();

  const response = await callTool(server, "run_tabs", {
    timeoutMs: 40,
    tabs: [
      {
        sessionId: "session-1",
        steps: [
          { tool: "sleep", arguments: { ms: 10_000 } },
          { tool: "click", arguments: { selector: "#after-sleep" } },
        ],
      },
      {
        sessionId: "session-2",
        steps: [
          { tool: "take_screenshot" },
          { tool: "click", arguments: { selector: "#after-shot" } },
        ],
      },
    ],
  });
  const value = response.result.structuredContent;
  const images = response.result.content.filter(
    (item) => item.type === "image",
  );

  assert.ok(Date.now() - startedAt < 1000, "the sleep was cut short");
  assert.deepEqual(
    value.tabs.map((tab) => [tab.ok, tab.ranSteps, tab.skippedSteps]),
    [
      [false, 1, 1],
      [false, 1, 1],
    ],
  );
  assert.match(value.tabs[1].error, /did not finish within 40ms/);
  // The screenshot in progress finished and is reported with its image.
  assert.equal(value.tabs[1].steps[0].result.image, 1);
  assert.equal(images.length, 1);
  await delay(100);
  assert.deepEqual(clicks, []);
});

test("a tab that cannot be closed says so", async () => {
  const { manager } = createTabManager();
  manager.closeTarget = async () => {
    throw new Error("target already gone");
  };
  const value = (
    await callTool(createServer(manager), "run_tabs", {
      tabs: [{ url: "https://a.test/", steps: [read] }],
    })
  ).result.structuredContent;

  assert.equal(value.tabs[0].ok, true);
  assert.equal(value.tabs[0].closed, false);
  assert.equal(value.tabs[0].closeError, "target already gone");
});
