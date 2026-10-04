import { MAX_RUN_STEPS, stepSchema } from "./run-steps.mjs";
import { asImageToolResult } from "./tool-results.mjs";
import { waitUntilProperty, withoutDescriptions } from "./tool-schemas.mjs";

export const MAX_TABS = 8;
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
        description: `At most ${MAX_TABS}, each with url or sessionId, and steps.`,
        items: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Open this in a new tab.",
            },
            waitUntil: waitUntilProperty(),
            sessionId: {
              type: "string",
              description: "Use this session instead.",
            },
            steps: {
              type: "array",
              maxItems: MAX_RUN_STEPS,
              description: "As in run_steps.",
              items: withoutDescriptions(stepSchema()),
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
              description: "Required for url tabs in auto mode.",
            },
          }
        : {}),
      concurrency: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TABS,
        description: "Tabs at once (default all).",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TAB_TIMEOUT_MS,
        description: `ms per tab (default ${DEFAULT_TAB_TIMEOUT_MS}).`,
      },
      keepTabs: {
        type: "boolean",
        description: "Keep url tabs open and attached (default false).",
      },
      continueOnError: {
        type: "boolean",
        description: "Within each tab (default false).",
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
    const concurrency = Math.min(args.concurrency ?? tabs.length, tabs.length);
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
        description: `Run steps in several tabs at once and get every tab's results in one reply: {"tabs":[{"url":"https://a.example","steps":[{"tool":"read_text"}]},{"url":"https://b.example","steps":[{"tool":"read_text"}]}]}. A url tab opens, runs its steps, and closes unless keepTabs; a sessionId tab uses that session. Steps are as in run_steps. A tab that fails or passes timeoutMs does not stop the others.`,
        inputSchema: runTabsInputSchema(stepTools, configuredFamily),
      },
      handler: async (args) => runner.runTabs(args, configuredFamily),
      formatResult: asImageToolResult,
    },
  ];
}
