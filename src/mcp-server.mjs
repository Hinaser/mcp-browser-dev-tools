import { ChangeTracker } from "./action-changes.mjs";
import { actionTools } from "./tools/action-tools.mjs";
import { browserTools } from "./tools/browser-tools.mjs";
import { inspectionTools } from "./tools/inspection-tools.mjs";
import { stateTools } from "./tools/state-tools.mjs";
import { appendFile } from "node:fs/promises";
import { launchBrowser as launchLocalBrowser } from "./browser-launch-service.mjs";
import {
  requestedBrowserFamily,
  shouldCreateBrowserTab,
} from "./browser-requests.mjs";
import { MessageBuffer, encodeMessage } from "./json-rpc-stdio.mjs";
import { validateValue } from "./json-schema.mjs";
import { createLogger } from "./logger.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";
import { StepRunner, runStepsTool, stepSchema } from "./run-steps.mjs";
import { TabRunner, runTabsTool } from "./run-tabs.mjs";
import { asToolResult } from "./tool-results.mjs";

const SERVER_NAME = PACKAGE_NAME;

const SERVER_VERSION = PACKAGE_VERSION;

function formatChunkPreview(chunk, limit = 160) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return buffer
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function success(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function isRequestedBrowserAvailable(
  status,
  configuredFamily,
  requestedFamily,
) {
  if (configuredFamily !== "auto" || !requestedFamily) {
    return Boolean(status?.available);
  }

  // Edge shares the Chromium adapter in auto mode.
  const adapterFamily =
    requestedFamily === "edge" ? "chromium" : requestedFamily;
  return Boolean(status?.browsers?.[adapterFamily]?.available);
}

const STATUS_PROBE_ATTEMPTS = 3;

const LAUNCH_GRACE_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class McpBrowserDevToolsServer {
  constructor({
    config,
    browserAdapter,
    launchBrowser = launchLocalBrowser,
    statusProbeRetryMs = 500,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    logger = createLogger({
      level: config.logLevel,
      output: errorOutput,
      name: SERVER_NAME,
    }),
  }) {
    this.config = config;
    this.browserAdapter = browserAdapter;
    this.launchBrowser = launchBrowser;
    this.statusProbeRetryMs = statusProbeRetryMs;
    this.launchQueue = Promise.resolve();
    this.unconfirmedLaunches = new Map();
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.logger = logger;
    this.messageBuffer = new MessageBuffer();
    this.tools = this.createTools();
  }

  // Runs launch decisions one at a time, so parallel tool calls see the browser
  // the first call started instead of each launching their own.
  runExclusiveLaunch(task) {
    const run = this.launchQueue.then(task, task);
    this.launchQueue = run.catch(() => {});
    return run;
  }

  // A busy browser can miss a single status check, and treating that as "not
  // running" would launch a second browser, so retry before giving up.
  async probeBrowser(browserFamily) {
    let status = null;
    for (let attempt = 0; attempt < STATUS_PROBE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.statusProbeRetryMs);
      }

      status = await this.browserAdapter.getBrowserStatus();
      if (
        isRequestedBrowserAvailable(
          status,
          this.config.browserFamily,
          browserFamily,
        )
      ) {
        this.unconfirmedLaunches.delete(
          browserFamily ?? this.config.browserFamily,
        );
        return { status, available: true };
      }
    }

    return { status, available: false };
  }

  // A browser can take a while to expose its endpoint after launch. Launching
  // again in that window would start a second browser, so refuse until the
  // first one answers or the grace period passes.
  async launchUnlessPending(browserFamily, options) {
    const key = browserFamily ?? this.config.browserFamily;
    const launchedAt = this.unconfirmedLaunches.get(key);
    if (launchedAt !== undefined && Date.now() - launchedAt < LAUNCH_GRACE_MS) {
      const seconds = Math.round((Date.now() - launchedAt) / 1000);
      throw new Error(
        `A ${key} browser launched ${seconds}s ago has not exposed its debugging endpoint yet, so another one was not launched. Wait a few seconds and call ensure_browser again.`,
      );
    }

    const launch = await this.launchBrowser(options);
    const confirmed =
      launch?.launched === false ||
      launch?.doctorReport?.browserStatus?.available === true;
    if (confirmed) {
      this.unconfirmedLaunches.delete(key);
    } else {
      this.unconfirmedLaunches.set(key, Date.now());
    }
    return launch;
  }

  async ensureBrowser(args) {
    const browserFamily = requestedBrowserFamily(
      this.config.browserFamily,
      args.browserFamily,
    );
    const { status: currentStatus, available } =
      await this.probeBrowser(browserFamily);
    let launch = null;
    let status = currentStatus;

    if (!available) {
      if (args.launchIfMissing === false) {
        return {
          browserFamily,
          available: false,
          launched: false,
          status,
          tab: null,
        };
      }

      launch = await this.launchUnlessPending(browserFamily, {
        config: this.config,
        browserFamily,
        url: args.url,
        port: args.port,
        address: args.address,
        userDataDir: args.userDataDir,
        unsafeArgs: args.unsafeArgs,
        waitMs: args.waitMs,
        skipDoctor: args.skipDoctor,
      });
      ({ status } = await this.probeBrowser(browserFamily));
    }

    let tab = null;
    if (shouldCreateBrowserTab(args)) {
      tab = await this.browserAdapter.createTab(args.url, {
        browserFamily,
      });
    }

    return {
      browserFamily,
      available: isRequestedBrowserAvailable(
        status,
        this.config.browserFamily,
        browserFamily,
      ),
      launched: Boolean(launch) && launch.launched !== false,
      launch,
      status,
      tab,
    };
  }

  createTools() {
    this.changeTracker = new ChangeTracker(this.browserAdapter);
    const tools = [
      ...browserTools(this),
      ...stateTools(this),
      ...actionTools(this),
      ...inspectionTools(this),
    ];

    const stepTools = tools
      .filter(([, tool]) =>
        tool.definition.inputSchema.required?.includes("sessionId"),
      )
      .map(([name]) => name);
    this.stepRunner = new StepRunner({
      getTools: () => this.tools,
      browserAdapter: this.browserAdapter,
      changeTracker: this.changeTracker,
      stepSchema: stepSchema(stepTools),
      conditionOptions: { expression: this.config.enableEvaluate },
    });
    tools.push(runStepsTool(this.stepRunner, stepTools));
    this.tabRunner = new TabRunner({
      stepRunner: this.stepRunner,
      browserAdapter: this.browserAdapter,
    });
    tools.push(
      runTabsTool(this.tabRunner, stepTools, this.config.browserFamily),
    );

    return new Map(tools);
  }

  start() {
    let sawInput = false;

    this.input.on("data", (chunk) => {
      sawInput = true;
      if (this.config.debugStdio) {
        this.logger.log(
          "debug",
          `stdin chunk bytes=${chunk.length} preview="${formatChunkPreview(chunk)}"`,
          { force: true },
        );
      }

      let messages;
      try {
        messages = this.messageBuffer.push(chunk);
      } catch (error) {
        this.logger.error(`failed to parse incoming message: ${error.message}`);
        return;
      }

      for (const message of messages) {
        void this.dispatch(message);
      }
    });

    if (this.config.debugStdio) {
      this.input.on("end", () => {
        this.logger.log("debug", `stdin ended after_input=${sawInput}`, {
          force: true,
        });
      });

      this.input.on("close", () => {
        this.logger.log("debug", `stdin closed after_input=${sawInput}`, {
          force: true,
        });
      });
    }

    if (typeof this.input.resume === "function") {
      this.input.resume();
    }

    this.logger.info(
      `listening on stdio for MCP messages; browser=${this.config.browserFamily}`,
    );
  }

  async dispatch(message) {
    const response = await this.handleRequest(message);
    if (!response) {
      return;
    }

    this.output.write(
      encodeMessage(
        response,
        this.messageBuffer.transportMode ?? "content-length",
      ),
    );
  }

  async handleRequest(message) {
    const id = message?.id ?? null;

    if (message?.jsonrpc !== "2.0") {
      return failure(id, -32600, "Invalid Request");
    }

    try {
      switch (message.method) {
        case "initialize":
          return success(id, {
            protocolVersion: this.config.protocolVersion,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
            instructions:
              'Use the browser tools to inspect tabs, console output, network activity, DOM structure, element state, screenshots, and page interactions across Chromium CDP or Firefox BiDi. To see what a page offers, call get_snapshot first: it lists the visible headings and controls, one line each with a ref such as e12, and ref=e12 works as the selector of any tool; it is far cheaper than get_document or a screenshot. To act on a page, prefer run_steps: send the actions you already know (such as every field of a form) in one call instead of several round trips, for example {"sessionId":"<id>","steps":[{"tool":"type","arguments":{"selector":"ref=e3","text":"headphones"}},{"tool":"press_key","arguments":{"key":"Enter"}}]}. Actions and batches with actions return changes once the page settles: headings and controls added, removed, or updated (snapshot lines with refs), new text such as an error or a toast, the URL and title, console errors and dialogs, and after a navigation a snapshot of the new page. That is usually the check, so a screenshot or another get_snapshot is rarely needed; add wait_for for something that arrives later. Add an if step when the page can be in more than one state. To read several pages, open them together with run_tabs and read each with read_text. Locators: ref=e12 takes the element get_snapshot listed, until the page navigates; plain CSS (or css=) takes the first match; text=Foo takes the first visible element whose text equals Foo, else contains it, in document order, so it can match a wrapper; role=button[name="Save"] matches ARIA role and accessible name (equal or containing) without a visibility check; name=Foo takes the first visible element whose accessible name equals or contains Foo, and a matched <label> resolves to its control when that control is visible. Comparisons are case-sensitive; iframes and shadow roots are not searched.',
          });
        case "notifications/initialized":
          return null;
        case "ping":
          return success(id, {});
        case "tools/list":
          return success(id, {
            tools: Array.from(this.tools.values(), (tool) => tool.definition),
          });
        case "tools/call":
          return success(id, await this.callTool(message.params));
        default:
          if (message.id === undefined) {
            return null;
          }
          return failure(id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return failure(id, -32000, error.message);
    }
  }

  async callTool(params = {}) {
    const startedAt = Date.now();
    let response = null;
    try {
      const tool = this.tools.get(params.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${params.name}`);
      }

      const args = params.arguments ?? {};
      validateValue("arguments", args, tool.definition.inputSchema);
      tool.validate?.(args);
      const result = await tool.handler(args);
      response = (tool.formatResult ?? asToolResult)(result, args);
      return response;
    } finally {
      await this.logTiming(params.name, startedAt, response);
    }
  }

  // Appends one JSON line per tool call when MCP_BROWSER_TIMING_LOG is set.
  // responseChars and images approximate what the call costs the client.
  async logTiming(name, startedAt, response) {
    if (!this.config.timingLogFile) {
      return;
    }

    const content = response?.content ?? [];
    const entry = {
      ts: new Date(startedAt).toISOString(),
      tool: name ?? null,
      ms: Date.now() - startedAt,
      ok: response !== null,
      responseChars: content
        .filter((block) => block.type === "text")
        .reduce((total, block) => total + block.text.length, 0),
      images: content.filter((block) => block.type === "image").length,
    };
    // ok is whether the call returned; a batch that stopped at a failing
    // step still returns, so its own outcome is logged as stepsOk.
    if (name === "run_steps" && response?.structuredContent) {
      entry.steps = response.structuredContent.ranSteps;
      entry.stepsOk = response.structuredContent.ok;
    }

    try {
      await appendFile(this.config.timingLogFile, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      this.logger.error(`failed to write timing log: ${error.message}`);
    }
  }
}
