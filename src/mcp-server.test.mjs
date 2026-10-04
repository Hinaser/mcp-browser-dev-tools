import test from "node:test";

import assert from "node:assert/strict";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { McpBrowserDevToolsServer } from "./mcp-server.mjs";
import { PACKAGE_VERSION } from "./package-info.mjs";
import { TOOL_GROUPS } from "./tool-sets.mjs";
import {
  callRunSteps,
  callTool,
  createFakeManager,
  createFlakyClickManager,
  createLaunchServer,
} from "./mcp-test-support.mjs";

test("initialize returns MCP server metadata", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
    },
  });

  assert.equal(response.result.serverInfo.name, "mcp-browser-dev-tools");
  assert.equal(response.result.serverInfo.version, PACKAGE_VERSION);
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.match(response.result.instructions, /prefer run_steps/);
});

test("start resumes the input stream so spawned stdio servers stay alive", () => {
  let resumed = false;
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
    input: {
      on() {},
      resume() {
        resumed = true;
      },
    },
    output: {
      write() {
        return true;
      },
    },
    errorOutput: {
      write() {
        return true;
      },
    },
  });

  server.start();

  assert.equal(resumed, true);
});

test("tools/list exposes the broker tools", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });

  const toolNames = response.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("list_tabs"));
  assert.ok(toolNames.includes("launch_browser"));
  assert.ok(toolNames.includes("ensure_browser"));
  assert.ok(toolNames.includes("new_tab"));
  assert.ok(toolNames.includes("close_tab"));
  assert.ok(toolNames.includes("get_page_state"));
  assert.ok(toolNames.includes("compare_page_state"));
  assert.ok(toolNames.includes("compare_selector"));
  assert.ok(toolNames.includes("get_cookies"));
  assert.ok(toolNames.includes("get_storage"));
  assert.ok(toolNames.includes("capture_debug_report"));
  assert.ok(toolNames.includes("capture_session_snapshot"));
  assert.ok(toolNames.includes("restore_session_snapshot"));
  assert.ok(toolNames.includes("get_har"));
  assert.ok(toolNames.includes("wait_for"));
  assert.ok(toolNames.includes("navigate"));
  assert.ok(toolNames.includes("click"));
  assert.ok(toolNames.includes("type"));
  assert.ok(toolNames.includes("set_viewport"));
  assert.ok(toolNames.includes("get_console_messages"));
  assert.ok(toolNames.includes("get_network_requests"));
  assert.ok(toolNames.includes("inspect_element"));
  assert.ok(toolNames.includes("get_events"));
  assert.ok(toolNames.includes("evaluate_js"));
});

test("tools/call executes a tool and returns structured content", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "attach_tab",
      arguments: {
        targetId: "tab-1",
      },
    },
  });

  assert.equal(response.result.structuredContent.sessionId, "session-2");
  assert.match(response.result.content[0].text, /session-2/);
});

test("browser_status includes broker version metadata", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 36,
    method: "tools/call",
    params: {
      name: "browser_status",
      arguments: {},
    },
  });

  assert.equal(
    response.result.structuredContent.serverName,
    "mcp-browser-dev-tools",
  );
  assert.equal(
    response.result.structuredContent.serverVersion,
    PACKAGE_VERSION,
  );
  assert.equal(response.result.structuredContent.available, true);
});

test("launch_browser delegates to the launch service", async () => {
  let capturedArgs = null;
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      capturedArgs = args;
      return {
        browserFamily: "chromium",
        url: args.url ?? "about:blank",
        executable: "/usr/bin/chromium",
        args: ["--remote-debugging-port=9222", "about:blank"],
        pid: 1234,
        endpoint: "http://127.0.0.1:9222",
        doctorReport: {
          browserStatus: {
            available: true,
          },
        },
      };
    },
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 53,
    method: "tools/call",
    params: {
      name: "launch_browser",
      arguments: {
        browserFamily: "chromium",
        url: "https://example.com/app",
        waitMs: 2000,
      },
    },
  });

  assert.equal(capturedArgs.url, "https://example.com/app");
  assert.equal(capturedArgs.browserFamily, "chromium");
  assert.equal(capturedArgs.waitMs, 2000);
  assert.equal(response.result.structuredContent.pid, 1234);
  assert.equal(
    response.result.structuredContent.endpoint,
    "http://127.0.0.1:9222",
  );
});

test("launch_browser passes unsafeArgs through when enabled", async () => {
  let capturedArgs = null;
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
    }),
    browserAdapter: createFakeManager(),
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      capturedArgs = args;
      return {
        browserFamily: "chromium",
        url: "about:blank",
        executable: "/usr/bin/chromium",
        args: ["--remote-debugging-port=9222", "about:blank"],
        pid: 1234,
        endpoint: "http://127.0.0.1:9222",
        unsafeArgs: args.unsafeArgs ?? [],
        doctorReport: {
          browserStatus: {
            available: true,
          },
        },
      };
    },
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 153,
    method: "tools/call",
    params: {
      name: "launch_browser",
      arguments: {
        browserFamily: "chromium",
        unsafeArgs: ["--remote-allow-origins=http://localhost:9222"],
      },
    },
  });

  assert.deepEqual(capturedArgs.unsafeArgs, [
    "--remote-allow-origins=http://localhost:9222",
  ]);
  assert.deepEqual(response.result.structuredContent.unsafeArgs, [
    "--remote-allow-origins=http://localhost:9222",
  ]);
});

test("ensure_browser opens a tab when a compatible browser is already available", async () => {
  let capturedCreateTab = null;
  const browserAdapter = createFakeManager();
  browserAdapter.getBrowserStatus = async () => ({
    available: true,
    browserFamily: "auto",
    browsers: {
      chromium: { available: true },
      firefox: { available: false },
    },
  });
  browserAdapter.createTab = async (url, options = {}) => {
    capturedCreateTab = { url, options };
    return {
      targetId: "tab-3",
      url,
      browserFamily: options.browserFamily ?? "chromium",
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter,
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 55,
    method: "tools/call",
    params: {
      name: "ensure_browser",
      arguments: {
        browserFamily: "chromium",
        url: "https://example.com/dashboard",
      },
    },
  });

  assert.equal(response.result.structuredContent.available, true);
  assert.equal(response.result.structuredContent.launched, false);
  assert.equal(response.result.structuredContent.tab.targetId, "tab-3");
  assert.deepEqual(capturedCreateTab, {
    url: "https://example.com/dashboard",
    options: {
      browserFamily: "chromium",
    },
  });
});

test("ensure_browser launches a browser when none is reachable", async () => {
  let launchCalls = 0;
  let statusCalls = 0;
  const browserAdapter = createFakeManager();
  browserAdapter.getBrowserStatus = async () => {
    statusCalls += 1;
    return {
      available: launchCalls > 0,
      browserFamily: "auto",
      browsers:
        launchCalls > 0
          ? {
              chromium: { available: true },
              firefox: { available: false },
            }
          : {
              chromium: { available: false },
              firefox: { available: false },
            },
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter,
    statusProbeRetryMs: 0,
    launchBrowser: async (args) => {
      launchCalls += 1;
      return {
        browserFamily: args.browserFamily ?? "chromium",
        endpoint: "http://127.0.0.1:9222",
        doctorReport: {
          browserStatus: {
            available: true,
          },
        },
      };
    },
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 56,
    method: "tools/call",
    params: {
      name: "ensure_browser",
      arguments: {
        browserFamily: "chromium",
        launchIfMissing: true,
        createTab: false,
      },
    },
  });

  assert.equal(launchCalls, 1);
  assert.equal(statusCalls, 4, "three probes before launching, one after");
  assert.equal(response.result.structuredContent.available, true);
  assert.equal(response.result.structuredContent.launched, true);
  assert.equal(
    response.result.structuredContent.launch.endpoint,
    "http://127.0.0.1:9222",
  );
  assert.equal(response.result.structuredContent.tab, null);
});

test("new_tab delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 37,
    method: "tools/call",
    params: {
      name: "new_tab",
      arguments: {
        browserFamily: "chromium",
        url: "https://example.com/new",
      },
    },
  });

  assert.equal(response.result.structuredContent.targetId, "tab-2");
  assert.equal(
    response.result.structuredContent.url,
    "https://example.com/new",
  );
});

test("close_tab delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 38,
    method: "tools/call",
    params: {
      name: "close_tab",
      arguments: {
        targetId: "tab-1",
      },
    },
  });

  assert.equal(response.result.structuredContent.closed, true);
  assert.deepEqual(response.result.structuredContent.detachedSessions, [
    { sessionId: "session-1" },
  ]);
});

test("wait_for delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: {
      name: "wait_for",
      arguments: {
        sessionId: "session-1",
        selector: "#app",
        state: "visible",
        timeoutMs: 1000,
      },
    },
  });

  assert.equal(response.result.structuredContent.matched, true);
  assert.equal(response.result.structuredContent.condition.selector, "#app");
  assert.equal(response.result.structuredContent.condition.state, "visible");
});

test("inspect_element delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: {
      name: "inspect_element",
      arguments: {
        sessionId: "session-1",
        selector: "#app",
      },
    },
  });

  assert.equal(response.result.structuredContent.selector, "#app");
  assert.equal(response.result.structuredContent.found, true);
});

test("navigate delegates to the browser adapter", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 34,
    method: "tools/call",
    params: {
      name: "navigate",
      arguments: {
        sessionId: "session-1",
        url: "https://example.com/settings",
        waitUntil: "interactive",
      },
    },
  });

  assert.equal(
    response.result.structuredContent.url,
    "https://example.com/settings",
  );
  assert.equal(response.result.structuredContent.waitUntil, "interactive");
});

test("evaluate_js is exposed by default and hidden when disabled", async () => {
  for (const [env, exposed] of [
    [{}, true],
    [{ MCP_BROWSER_ENABLE_EVAL: "0" }, false],
  ]) {
    const server = new McpBrowserDevToolsServer({
      config: loadConfig(env),
      browserAdapter: createFakeManager(),
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/list",
    });

    const toolNames = response.result.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("evaluate_js"), exposed);
  }
});

test("expression conditions follow MCP_BROWSER_ENABLE_EVAL", async () => {
  for (const [env, exposed] of [
    [{}, true],
    [{ MCP_BROWSER_ENABLE_EVAL: "0" }, false],
  ]) {
    const server = new McpBrowserDevToolsServer({
      config: loadConfig(env),
      browserAdapter: createFakeManager(),
    });

    const list = await server.handleRequest({
      jsonrpc: "2.0",
      id: 32,
      method: "tools/list",
    });
    const waitFor = list.result.tools.find((tool) => tool.name === "wait_for");
    assert.equal("expression" in waitFor.inputSchema.properties, exposed);
    assert.equal(
      "expression" in waitFor.inputSchema.properties.anyOf.items.properties,
      exposed,
    );

    const waited = await callTool(server, "wait_for", {
      sessionId: "session-1",
      expression: "true",
      timeoutMs: 50,
    });
    assert.equal(waited.error === undefined, exposed);

    const branched = await callTool(server, "run_steps", {
      sessionId: "session-1",
      steps: [
        {
          tool: "if",
          arguments: { condition: { expression: "true" }, then: [] },
        },
      ],
    });
    assert.equal(branched.error === undefined, exposed);
    if (!exposed) {
      assert.match(
        branched.error.message,
        /condition\.expression is not allowed/,
      );
    }
  }
});

test("initialize returns the server protocol version, not the client hint", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 32,
    method: "initialize",
    params: {
      protocolVersion: "9999-99-99",
    },
  });

  assert.equal(response.result.protocolVersion, "2024-11-05");
});

test("unknown tool calls return an error response", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "missing_tool",
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /Unknown tool/);
});

test("tool calls validate arguments against the declared schema", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "get_events",
      arguments: {
        sessionId: "session-1",
        limit: "50",
      },
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /arguments\.limit must be an integer/);
});

test("get_storage filters the requested storage area", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: {
      name: "get_storage",
      arguments: {
        sessionId: "session-1",
        area: "localStorage",
      },
    },
  });

  assert.deepEqual(response.result.structuredContent.storage, {
    localStorage: {
      type: "localStorage",
      totalEntries: 1,
      returnedEntries: 1,
      truncated: false,
      entries: [{ key: "theme", value: "light" }],
    },
  });
});

test("compare_page_state compares bounded page fields across sessions", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 45,
    method: "tools/call",
    params: {
      name: "compare_page_state",
      arguments: {
        sessionIdA: "session-1",
        sessionIdB: "session-2",
      },
    },
  });

  assert.equal(response.result.structuredContent.matches, true);
  assert.equal(response.result.structuredContent.fields.url.equal, true);
});

test("compare_selector compares bounded element fields across sessions", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 46,
    method: "tools/call",
    params: {
      name: "compare_selector",
      arguments: {
        sessionIdA: "session-1",
        sessionIdB: "session-2",
        selector: "#app",
      },
    },
  });

  assert.equal(response.result.structuredContent.selector, "#app");
  assert.equal(response.result.structuredContent.matches, true);
  assert.equal(response.result.structuredContent.fields.found.equal, true);
});

test("restore_session_snapshot parses snapshot JSON before delegating", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 47,
    method: "tools/call",
    params: {
      name: "restore_session_snapshot",
      arguments: {
        sessionId: "session-1",
        snapshot: JSON.stringify({
          page: { url: "https://example.com/dashboard" },
          storage: {
            localStorage: {
              entries: [{ key: "theme", value: "dark" }],
            },
          },
        }),
        clearStorage: true,
      },
    },
  });

  assert.equal(response.result.structuredContent.clearStorage, true);
  assert.equal(
    response.result.structuredContent.snapshot.storage.localStorage.entries[0]
      .value,
    "dark",
  );
});

test("select requires either value or label", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 51,
    method: "tools/call",
    params: {
      name: "select",
      arguments: {
        sessionId: "session-1",
        selector: "#plan",
      },
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /requires either value or label/);
});

test("wait_for requires at least one condition", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 52,
    method: "tools/call",
    params: {
      name: "wait_for",
      arguments: {
        sessionId: "session-1",
      },
    },
  });

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /requires at least one/);
});

test("Firefox tool schemas only advertise screenshot formats the adapter supports", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_FAMILY: "firefox",
    }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
  });

  const screenshotTool = response.result.tools.find(
    (tool) => tool.name === "take_screenshot",
  );

  assert.deepEqual(screenshotTool.inputSchema.properties.format.enum, [
    "png",
    "jpeg",
  ]);
});

test("auto mode requires browserFamily when creating a new tab", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_FAMILY: "auto",
    }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 39,
    method: "tools/list",
  });

  const newTabTool = response.result.tools.find(
    (tool) => tool.name === "new_tab",
  );

  assert.deepEqual(newTabTool.inputSchema.properties.browserFamily.enum, [
    "chromium",
    "firefox",
  ]);
  assert.deepEqual(newTabTool.inputSchema.required, ["browserFamily"]);
});

test("auto mode requires browserFamily when launching a browser", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_FAMILY: "auto",
    }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 54,
    method: "tools/list",
  });

  const launchBrowserTool = response.result.tools.find(
    (tool) => tool.name === "launch_browser",
  );

  assert.deepEqual(
    launchBrowserTool.inputSchema.properties.browserFamily.enum,
    ["chromium", "edge", "firefox"],
  );
  assert.deepEqual(launchBrowserTool.inputSchema.required, ["browserFamily"]);
  assert.equal(
    Object.hasOwn(launchBrowserTool.inputSchema.properties, "unsafeArgs"),
    false,
  );
});

test("auto mode requires browserFamily when ensuring a browser", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_FAMILY: "auto",
    }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 57,
    method: "tools/list",
  });

  const ensureBrowserTool = response.result.tools.find(
    (tool) => tool.name === "ensure_browser",
  );

  assert.deepEqual(
    ensureBrowserTool.inputSchema.properties.browserFamily.enum,
    ["chromium", "edge", "firefox"],
  );
  assert.deepEqual(ensureBrowserTool.inputSchema.required, ["browserFamily"]);
  assert.equal(
    Object.hasOwn(ensureBrowserTool.inputSchema.properties, "unsafeArgs"),
    false,
  );
});

test("unsafe launch args are only exposed when explicitly enabled", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS: "1",
    }),
    browserAdapter: createFakeManager(),
  });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 58,
    method: "tools/list",
  });

  const launchBrowserTool = response.result.tools.find(
    (tool) => tool.name === "launch_browser",
  );
  const ensureBrowserTool = response.result.tools.find(
    (tool) => tool.name === "ensure_browser",
  );

  for (const tool of [launchBrowserTool, ensureBrowserTool]) {
    const { description, ...shape } = tool.inputSchema.properties.unsafeArgs;
    assert.deepEqual(shape, {
      type: "array",
      items: {
        type: "string",
      },
    });
    assert.match(description, /Extra browser flags/);
  }
});

test("launch_browser reuses a reachable browser instead of launching another", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  const response = await callTool(server, "launch_browser", {
    browserFamily: "chromium",
  });

  assert.equal(launches.length, 0);
  assert.equal(response.result.structuredContent.reused, true);
  assert.equal(response.result.structuredContent.launched, false);
});

test("launch_browser launches on an explicit port even when a browser is reachable", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  await callTool(server, "launch_browser", {
    browserFamily: "chromium",
    port: 9333,
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].port, 9333);
});

test("parallel ensure_browser calls launch only one browser", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => launches.length > 0,
    launches,
  });

  const responses = await Promise.all(
    [1, 2, 3].map((id) =>
      callTool(
        server,
        "ensure_browser",
        { browserFamily: "chromium", createTab: false },
        id,
      ),
    ),
  );

  assert.equal(launches.length, 1);
  assert.deepEqual(
    responses.map((response) => response.result.structuredContent.launched),
    [true, false, false],
  );
});

test("ensure_browser does not launch when the browser misses one status check", async () => {
  const launches = [];
  let checks = 0;
  const server = createLaunchServer({
    chromiumAvailable: () => {
      checks += 1;
      return checks > 1;
    },
    launches,
  });

  const response = await callTool(server, "ensure_browser", {
    browserFamily: "chromium",
    createTab: false,
  });

  assert.equal(launches.length, 0);
  assert.equal(response.result.structuredContent.available, true);
});

test("ensure_browser treats Edge as available through the Chromium adapter in auto mode", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  const response = await callTool(server, "ensure_browser", {
    browserFamily: "edge",
    createTab: false,
  });

  assert.equal(launches.length, 0);
  assert.equal(response.result.structuredContent.available, true);
});

test("ensure_browser does not launch again while a launched browser is still starting", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => false,
    launches,
  });

  const [first, second] = await Promise.all([
    callTool(
      server,
      "ensure_browser",
      { browserFamily: "chromium", createTab: false },
      1,
    ),
    callTool(
      server,
      "ensure_browser",
      { browserFamily: "chromium", createTab: false },
      2,
    ),
  ]);

  assert.equal(launches.length, 1);
  assert.equal(first.result.structuredContent.launched, true);
  assert.match(
    second.error.message,
    /has not exposed its debugging endpoint yet/,
  );
});

test("launch_browser with an explicit profile does not reuse the running browser", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });

  await callTool(server, "launch_browser", {
    browserFamily: "chromium",
    userDataDir: "/profiles/other",
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].userDataDir, "/profiles/other");
});

test("launch_browser opens the requested url when reusing a running browser", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => true,
    launches,
  });
  const tabs = [];
  server.browserAdapter.createTab = async (url, options) => {
    tabs.push([url, options.browserFamily]);
    return { targetId: "tab-9", url };
  };

  const response = await callTool(server, "launch_browser", {
    browserFamily: "chromium",
    url: "https://example.com/app",
  });

  assert.deepEqual(tabs, [["https://example.com/app", "chromium"]]);
  assert.equal(response.result.structuredContent.tab.targetId, "tab-9");
});

test("a confirmed launch does not block the next explicit launch", async () => {
  const launches = [];
  const server = createLaunchServer({
    chromiumAvailable: () => false,
    launches,
  });
  server.launchBrowser = async (args) => {
    launches.push(args);
    return {
      browserFamily: args.browserFamily,
      launched: true,
      doctorReport: { browserStatus: { available: true } },
    };
  };

  await callTool(server, "launch_browser", { browserFamily: "chromium" }, 1);
  const second = await callTool(
    server,
    "launch_browser",
    { browserFamily: "chromium", port: 9333 },
    2,
  );

  assert.equal(second.error, undefined);
  assert.equal(launches.length, 2);
});

test("wait_for passes anyOf and textExcludes to the adapter", async () => {
  const manager = createFakeManager();
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const anyOf = [
    { selector: "#status", textIncludes: "Paid" },
    { selector: "#status", textExcludes: "Processing" },
  ];
  const response = await callTool(server, "wait_for", {
    sessionId: "session-1",
    anyOf,
  });
  assert.deepEqual(response.result.structuredContent.condition.anyOf, anyOf);

  const mixed = await callTool(server, "wait_for", {
    sessionId: "session-1",
    selector: "#status",
    anyOf,
  });
  assert.match(mixed.error.message, /anyOf cannot be combined with selector/);

  const nested = await callTool(server, "wait_for", {
    sessionId: "session-1",
    anyOf: [{ anyOf }],
  });
  assert.match(nested.error.message, /anyOf is not allowed/);
});

test("wait_for passes text conditions to the adapter", async () => {
  const manager = createFakeManager();
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const response = await callTool(server, "wait_for", {
    sessionId: "session-1",
    selector: "#status",
    textIncludes: "Saved",
  });
  assert.equal(
    response.result.structuredContent.condition.textIncludes,
    "Saved",
  );

  const invalid = await callTool(server, "wait_for", {
    sessionId: "session-1",
    url: "https://example.com",
    textEquals: "Saved",
  });
  assert.match(invalid.error.message, /require selector/);
});

test("tool calls append timing entries when MCP_BROWSER_TIMING_LOG is set", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "timing-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, "timing.jsonl");
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({
      MCP_BROWSER_TOOLS: "all",
      MCP_BROWSER_TIMING_LOG: logFile,
    }),
    browserAdapter: createFakeManager(),
  });

  await callTool(server, "take_screenshot", {
    sessionId: "session-1",
    output: "image",
  });
  await callTool(server, "wait_for", { sessionId: "session-1" });
  await callTool(server, "run_steps", {
    sessionId: "session-1",
    steps: [{ tool: "inspect_element", arguments: { selector: "#a" } }],
  });

  const entries = (await readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].tool, "take_screenshot");
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].images, 1);
  assert.ok(entries[0].responseChars > 0);
  assert.equal(entries[1].tool, "wait_for");
  assert.equal(entries[1].ok, false);
  assert.equal(typeof entries[1].ms, "number");
  assert.equal(entries[2].steps, 1);
  assert.equal(entries[2].stepsOk, true);
});

test("the run_steps example in the server instructions is a valid call", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });
  const { instructions } = (
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })
  ).result;
  const example = JSON.parse(
    instructions.slice(
      instructions.indexOf("{"),
      instructions.lastIndexOf("}") + 1,
    ),
  );

  const response = await callRunSteps(server, {
    ...example,
    sessionId: "session-1",
  });

  assert.equal(response.error, undefined);
  assert.equal(
    response.result.structuredContent.ranSteps,
    example.steps.length,
  );
});

test("a failed run_steps batch reports the page and its controls", async () => {
  const { manager } = createFlakyClickManager([{ found: false }]);
  let snapshots = 0;
  manager.snapshotControls = async () => {
    snapshots += 1;
    return {
      url: "https://shop.test/pay",
      title: "Pay",
      controls: [{ locator: "#pay", role: "button", name: "Pay" }],
      moreControls: 0,
    };
  };
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: manager,
  });

  const failed = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [{ tool: "click", arguments: { selector: "#buy", timeoutMs: 0 } }],
    })
  ).result.structuredContent;
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.page, {
    url: "https://shop.test/pay",
    title: "Pay",
    controls: [{ locator: "#pay", role: "button", name: "Pay" }],
    moreControls: 0,
  });

  const passed = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [{ tool: "sleep", arguments: { ms: 0 } }],
    })
  ).result.structuredContent;
  assert.equal(passed.ok, true);
  assert.equal("page" in passed, false);
  assert.equal(snapshots, 1);

  manager.snapshotControls = async () => {
    throw new Error("Session closed");
  };
  const snapshotFailed = (
    await callRunSteps(server, {
      sessionId: "session-1",
      steps: [{ tool: "click", arguments: { selector: "#buy", timeoutMs: 0 } }],
    })
  ).result.structuredContent;
  assert.equal(snapshotFailed.ok, false);
  assert.equal("page" in snapshotFailed, false);
});

// Every turn of every conversation pays for the tool definitions, so their
// size is held to a budget; raise it only for something worth the cost.
test("the default core tool set stays within its size budget", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({}),
    browserAdapter: createFakeManager(),
  });
  const { tools } = (
    await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).result;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_GROUPS.core].sort(),
  );
  assert.ok(
    JSON.stringify(tools).length <= 17_000,
    `core tool definitions are ${JSON.stringify(tools).length} characters`,
  );
});

test("the tool definitions and instructions stay within their size budget", async () => {
  const server = new McpBrowserDevToolsServer({
    config: loadConfig({ MCP_BROWSER_TOOLS: "all" }),
    browserAdapter: createFakeManager(),
  });
  const { tools } = (
    await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).result;
  const { instructions } = (
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })
  ).result;

  assert.ok(
    JSON.stringify(tools).length <= 25_500,
    `tool definitions are ${JSON.stringify(tools).length} characters`,
  );
  assert.ok(instructions.length <= 1_600);
  assert.doesNotMatch(JSON.stringify(tools), /"additionalProperties":false/);
});
