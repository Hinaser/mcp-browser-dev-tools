import { MAX_RUN_STEPS, stepSchema } from "./run-steps.mjs";
import { asImageToolResult } from "./tool-results.mjs";
import { waitUntilProperty } from "./tool-schemas.mjs";

export const MAX_TABS = 8;
export const DEFAULT_TAB_CONCURRENCY = 4;
export const DEFAULT_TAB_TIMEOUT_MS = 60_000;
export const MAX_TAB_TIMEOUT_MS = 300_000;

export function runTabsInputSchema(stepTools, browserFamily) {
  return {
    type: "object",
    properties: {
      tabs: {
        type: "array",
        minItems: 1,
        maxItems: MAX_TABS,
        description: `Tabs to run at the same time (at most ${MAX_TABS}). Each gives either url, to open a new tab there, or sessionId, to use an attached tab, plus the steps to run in it.`,
        items: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "Open a new tab, attach to it, and load this URL before the steps.",
            },
            waitUntil: waitUntilProperty(),
            sessionId: {
              type: "string",
              description:
                "Run the steps in this attached session instead of opening a tab.",
            },
            steps: {
              type: "array",
              maxItems: MAX_RUN_STEPS,
              description: `Steps to run in this tab, as in run_steps (at most ${MAX_RUN_STEPS}, default none).`,
              items: stepSchema(stepTools),
            },
          },
          additionalProperties: false,
        },
      },
      ...(browserFamily === "auto"
        ? {
            browserFamily: {
              type: "string",
              enum: ["chromium", "firefox"],
              description:
                "Browser to open the url tabs in. Required when a tab gives url.",
            },
          }
        : {}),
      concurrency: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TABS,
        description: `How many tabs run at once (default ${DEFAULT_TAB_CONCURRENCY}).`,
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TAB_TIMEOUT_MS,
        description: `How long each tab may take, from opening to its last step, before it fails (default ${DEFAULT_TAB_TIMEOUT_MS}).`,
      },
      keepTabs: {
        type: "boolean",
        description:
          "Leave the tabs opened for url open and attached, and report their sessionId (default false: close them).",
      },
      continueOnError: {
        type: "boolean",
        description:
          "Within each tab, run the remaining steps after a step fails (default false). A failing tab never stops the others.",
      },
    },
    required: ["tabs"],
    additionalProperties: false,
  };
}

function timeoutAfter(timeoutMs) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Tab did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  promise.catch(() => {});
  return { promise, clear: () => clearTimeout(timer) };
}

export class TabRunner {
  constructor({ stepRunner, browserAdapter }) {
    this.stepRunner = stepRunner;
    this.browserAdapter = browserAdapter;
  }

  prepareTabs(args, configuredFamily) {
    const sessionIds = new Set();
    const tabs = args.tabs.map((tab, index) => {
      const path = `arguments.tabs[${index}]`;
      if ((tab.url === undefined) === (tab.sessionId === undefined)) {
        throw new Error(`${path} needs either url or sessionId`);
      }
      if (tab.waitUntil !== undefined && tab.url === undefined) {
        throw new Error(`${path}.waitUntil requires url`);
      }
      if (tab.sessionId !== undefined) {
        if (sessionIds.has(tab.sessionId)) {
          throw new Error(
            `${path}.sessionId ${tab.sessionId} is already used by another tab`,
          );
        }
        sessionIds.add(tab.sessionId);
      }
      if (
        tab.url !== undefined &&
        configuredFamily === "auto" &&
        !args.browserFamily
      ) {
        throw new Error(
          "arguments.browserFamily is required when a tab gives url",
        );
      }

      const context = { sessionId: tab.sessionId ?? "", count: 0 };
      return {
        index,
        url: tab.url,
        waitUntil: tab.waitUntil ?? "complete",
        sessionId: tab.sessionId,
        steps: this.stepRunner.prepareSteps(
          tab.steps ?? [],
          context,
          `${path}.steps`,
          0,
        ),
      };
    });
    return tabs;
  }

  async runTab(tab, options, images) {
    const startedAt = Date.now();
    const entry = { index: tab.index, url: tab.url ?? null };
    const controller = new AbortController();
    let opened = null;
    let sessionId = tab.sessionId;

    const work = (async () => {
      if (tab.url !== undefined) {
        ({ targetId: opened } = await this.browserAdapter.createTab(
          "about:blank",
          { browserFamily: options.browserFamily },
        ));
        if (controller.signal.aborted) {
          return null;
        }
        ({ sessionId } = await this.browserAdapter.attachToTarget(opened));
        if (controller.signal.aborted) {
          return null;
        }
        await this.browserAdapter.navigate(sessionId, tab.url, {
          waitUntil: tab.waitUntil,
        });
      }
      return this.stepRunner.executeSteps(tab.steps, {
        sessionId,
        continueOnError: options.continueOnError,
        images,
        count: 0,
        signal: controller.signal,
      });
    })();

    const timeout = timeoutAfter(options.timeoutMs);
    let timedOut = false;
    try {
      const results = await Promise.race([work, timeout.promise]);
      const ok =
        results.length === tab.steps.length &&
        results.every((result) => result.ok);
      Object.assign(entry, {
        ok,
        ranSteps: results.length,
        skippedSteps: tab.steps.length - results.length,
        steps: results,
      });
    } catch (error) {
      timedOut = error.message.startsWith("Tab did not finish");
      Object.assign(entry, { ok: false, error: error.message });
    } finally {
      timeout.clear();
    }

    if (timedOut) {
      // Start no more steps, close a tab opened here so its work fails fast,
      // and wait for the step in progress to end before this worker moves
      // on, so no more than concurrency tabs are ever busy. Report the steps
      // that ran, so every screenshot in the reply belongs to a step.
      controller.abort();
      if (opened && !options.keepTabs) {
        await this.closeTab(opened, entry);
      }
      const results = await work.catch(() => null);
      if (Array.isArray(results)) {
        Object.assign(entry, {
          ranSteps: results.length,
          skippedSteps: tab.steps.length - results.length,
          steps: results,
        });
      }
    } else if (!entry.ok && sessionId) {
      Object.assign(
        entry,
        await this.stepRunner.describePageAfterFailure(sessionId),
      );
    }

    if (sessionId && (tab.sessionId !== undefined || options.keepTabs)) {
      entry.sessionId = sessionId;
    }
    if (opened) {
      entry.targetId = opened;
      if (!options.keepTabs && entry.closed === undefined) {
        await this.closeTab(opened, entry);
      }
      entry.closed ??= false;
    }
    entry.durationMs = Date.now() - startedAt;
    return entry;
  }

  async closeTab(targetId, entry) {
    try {
      await this.browserAdapter.closeTarget(targetId);
      entry.closed = true;
    } catch (error) {
      entry.closed = false;
      entry.closeError = error.message;
    }
  }

  async runTabs(args, configuredFamily) {
    // Validate every tab's steps before opening anything.
    const tabs = this.prepareTabs(args, configuredFamily);
    const options = {
      browserFamily: args.browserFamily,
      continueOnError: args.continueOnError === true,
      keepTabs: args.keepTabs === true,
      timeoutMs: args.timeoutMs ?? DEFAULT_TAB_TIMEOUT_MS,
    };
    const concurrency = Math.min(
      args.concurrency ?? DEFAULT_TAB_CONCURRENCY,
      tabs.length,
    );
    const images = [];
    const results = new Array(tabs.length);
    let next = 0;
    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < tabs.length) {
          const tab = tabs[next];
          next += 1;
          results[tab.index] = await this.runTab(tab, options, images);
        }
      }),
    );

    return {
      value: {
        ok: results.every((result) => result.ok),
        durationMs: Date.now() - startedAt,
        tabs: results,
      },
      images,
    };
  }
}

export function runTabsTool(runner, stepTools, configuredFamily) {
  return [
    "run_tabs",
    {
      definition: {
        name: "run_tabs",
        description: `Run step lists in several tabs at the same time, in one call, and return every tab's results together. Use it to read or check several pages at once, for example to open search results side by side: {"tabs":[{"url":"https://example.com/a","steps":[{"tool":"read_text","arguments":{"maxChars":4000}}]},{"url":"https://example.com/b","steps":[{"tool":"read_text","arguments":{"maxChars":4000}}]}]}. A tab with url opens a new tab, loads the URL (waitUntil, default complete), and runs its steps; a tab with sessionId runs its steps in that attached tab. Steps are the same as in run_steps (including if and repeat) and are all validated before any tab opens. Tabs run ${DEFAULT_TAB_CONCURRENCY} at a time by default (concurrency, at most ${MAX_TABS}); each has timeoutMs (default ${DEFAULT_TAB_TIMEOUT_MS}) and fails on its own without stopping the others, with page controls reported as in run_steps. Tabs opened for a url are closed afterwards unless keepTabs is true.`,
        inputSchema: runTabsInputSchema(stepTools, configuredFamily),
      },
      handler: async (args) => runner.runTabs(args, configuredFamily),
      formatResult: asImageToolResult,
    },
  ];
}
