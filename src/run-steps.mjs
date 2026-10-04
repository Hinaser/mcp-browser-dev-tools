import { CHANGE_REPORTING_TOOLS } from "./action-changes.mjs";
import { validateValue } from "./json-schema.mjs";
import { checkPageCondition, normalizeWaitForOptions } from "./wait-for.mjs";
import { asImageToolResult, moveScreenshotImage } from "./tool-results.mjs";
import { conditionSchema } from "./tool-schemas.mjs";

// Resolves after ms, or at once when signal aborts.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export const MAX_RUN_STEPS = 50;

export const MAX_STEP_DEPTH = 4;

export const MAX_REPEAT = 10;

export const DEFAULT_REPEAT = 5;

export const MAX_SLEEP_MS = 30_000;

export function sleepStepSchema() {
  return {
    type: "object",
    properties: {
      ms: {
        type: "integer",
        minimum: 0,
        maximum: MAX_SLEEP_MS,
        description: `Milliseconds to wait (at most ${MAX_SLEEP_MS}).`,
      },
    },
    required: ["ms"],
    additionalProperties: false,
  };
}

export function ifStepSchema(conditionOptions) {
  const condition = conditionSchema(conditionOptions);
  const steps = {
    type: "array",
    items: { type: "object" },
  };
  return {
    type: "object",
    properties: {
      condition,
      then: steps,
      elseIf: {
        type: "array",
        items: {
          type: "object",
          properties: { condition, then: steps },
          required: ["condition"],
          additionalProperties: false,
        },
      },
      else: steps,
    },
    required: ["condition"],
    additionalProperties: false,
  };
}

export function repeatStepSchema(conditionOptions) {
  return {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        items: { type: "object" },
      },
      until: conditionSchema(conditionOptions),
      max: {
        type: "integer",
        minimum: 1,
        maximum: MAX_REPEAT,
        description: `Most passes to run (default ${DEFAULT_REPEAT}, at most ${MAX_REPEAT}).`,
      },
    },
    required: ["steps", "until"],
    additionalProperties: false,
  };
}

// Without stepTools, the schema leaves the tool names out: the definitions
// clients see describe them in a few words, and prepareSteps still checks
// each step against the full list.
export function stepSchema(stepTools = null) {
  return {
    type: "object",
    properties: {
      tool: {
        type: "string",
        ...(stepTools ? { enum: ["sleep", "if", "repeat", ...stepTools] } : {}),
        description: "A tool that takes sessionId, or sleep, if, repeat.",
      },
      arguments: {
        type: "object",
        description: "The tool's arguments without sessionId.",
      },
    },
    required: ["tool"],
    additionalProperties: false,
  };
}

export function runStepsInputSchema() {
  return {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: MAX_RUN_STEPS,
        description: `At most ${MAX_RUN_STEPS}, counting nested steps.`,
        items: stepSchema(),
      },
      continueOnError: {
        type: "boolean",
        description: "Default false.",
      },
    },
    required: ["sessionId", "steps"],
    additionalProperties: false,
  };
}

export function observeCondition(condition, check) {
  const observed = {};
  if (check.page) {
    observed.url = check.page.url ?? null;
    observed.readyState = check.page.readyState ?? null;
  }
  if (condition.selector) {
    observed.found = Boolean(check.element?.found);
    observed.visible = check.element?.node?.visible === true;
    if (
      condition.textEquals !== null ||
      condition.textIncludes !== null ||
      condition.textExcludes !== null
    ) {
      observed.text = check.text;
    }
  }
  if (condition.expression) {
    observed.expression = check.expression;
  }
  return observed;
}

// Moves screenshot data out of a step result so the client receives it as
// image content, leaving `image` (1-based position among the images) behind.
export function extractStepImages(tool, result, images) {
  if (tool === "take_screenshot") {
    return moveScreenshotImage(result, images);
  }

  if (tool === "capture_debug_report" && result?.screenshot) {
    return {
      ...result,
      screenshot: moveScreenshotImage(result.screenshot, images),
    };
  }

  return result;
}

// Whether a prepared batch runs an action that reports its changes,
// including inside if branches and repeat bodies.
function containsChangeReportingStep(steps) {
  return steps.some(
    (step) =>
      CHANGE_REPORTING_TOOLS.has(step.tool) ||
      (step.steps && containsChangeReportingStep(step.steps)) ||
      (step.branches &&
        step.branches.some((branch) =>
          containsChangeReportingStep(branch.steps),
        )) ||
      (step.else && containsChangeReportingStep(step.else)),
  );
}

// Validates and runs run_steps batches against the server's tools.
export class StepRunner {
  constructor({
    getTools,
    browserAdapter,
    changeTracker = null,
    stepSchema,
    conditionOptions,
  }) {
    this.getTools = getTools;
    this.browserAdapter = browserAdapter;
    this.changeTracker = changeTracker;
    this.stepSchema = stepSchema;
    this.conditionOptions = conditionOptions;
  }

  prepareSteps(steps, context, pathPrefix, depth) {
    return steps.map((step, index) => {
      const stepPath = `${pathPrefix}[${index}]`;
      validateValue(stepPath, step, this.stepSchema);
      context.count += 1;
      if (context.count > MAX_RUN_STEPS) {
        throw new Error(
          `run_steps allows at most ${MAX_RUN_STEPS} steps, counting steps inside if branches and repeat bodies`,
        );
      }

      const path = `${stepPath}.arguments`;
      const stepArgs = step.arguments ?? {};
      if (step.tool === "sleep") {
        validateValue(path, stepArgs, sleepStepSchema());
        return { tool: step.tool, args: stepArgs };
      }

      if (
        (step.tool === "if" || step.tool === "repeat") &&
        depth >= MAX_STEP_DEPTH
      ) {
        throw new Error(
          `${path} nests if and repeat deeper than ${MAX_STEP_DEPTH} levels`,
        );
      }

      if (step.tool === "repeat") {
        validateValue(path, stepArgs, repeatStepSchema(this.conditionOptions));
        return {
          tool: step.tool,
          max: stepArgs.max ?? DEFAULT_REPEAT,
          until: normalizeWaitForOptions(stepArgs.until, `${path}.until`),
          steps: this.prepareSteps(
            stepArgs.steps,
            context,
            `${path}.steps`,
            depth + 1,
          ),
        };
      }

      if (step.tool === "if") {
        validateValue(path, stepArgs, ifStepSchema(this.conditionOptions));
        const prepareBranch = (branch, branchPath) => ({
          condition: normalizeWaitForOptions(
            branch.condition,
            `${branchPath}.condition`,
          ),
          steps: this.prepareSteps(
            branch.then ?? [],
            context,
            `${branchPath}.then`,
            depth + 1,
          ),
        });
        return {
          tool: step.tool,
          branches: [
            { name: "then", ...prepareBranch(stepArgs, path) },
            ...(stepArgs.elseIf ?? []).map((branch, branchIndex) => ({
              name: `elseIf[${branchIndex}]`,
              ...prepareBranch(branch, `${path}.elseIf[${branchIndex}]`),
            })),
          ],
          else: this.prepareSteps(
            stepArgs.else ?? [],
            context,
            `${path}.else`,
            depth + 1,
          ),
        };
      }

      if (stepArgs.sessionId !== undefined) {
        throw new Error(
          `${path}.sessionId is not allowed; run_steps passes its own sessionId`,
        );
      }

      const toolArgs = { ...stepArgs, sessionId: context.sessionId };
      const tool = this.getTools().get(step.tool);
      validateValue(path, toolArgs, tool.definition.inputSchema);
      tool.validate?.(toolArgs);
      return { tool: step.tool, args: toolArgs };
    });
  }

  async checkStepCondition(condition, context) {
    const check = await checkPageCondition({
      getPageState: () => this.browserAdapter.getPageState(context.sessionId),
      inspectElement: (selector, options) =>
        this.browserAdapter.inspectElement(
          context.sessionId,
          selector,
          options,
        ),
      evaluate: (expression) =>
        this.browserAdapter.evaluate(context.sessionId, expression),
      normalized: condition,
    });
    if (!condition.anyOf) {
      return {
        matched: check.matched,
        observed: observeCondition(condition, check),
      };
    }
    return {
      matched: check.matched,
      observed: {
        matchedIndex: check.matchedIndex,
        anyOf: check.alternatives.map((alternative, index) =>
          observeCondition(condition.anyOf[index], alternative),
        ),
      },
    };
  }

  // Runs the steps, then checks until once, and repeats until it holds or max
  // passes have run. A failing step ends the loop even with continueOnError,
  // so a failed action is never retried blindly.
  async runRepeatStep(step, context) {
    const runs = [];
    const finish = (ok, matched, extra = {}) => ({
      ok,
      ...extra,
      result: { matched, passes: runs.length, max: step.max, runs },
    });
    for (let pass = 1; pass <= step.max; pass += 1) {
      const steps = await this.executeSteps(step.steps, context);
      if (context.signal?.aborted) {
        runs.push({ pass, steps });
        return finish(false, false, { error: "stopped: the tab timed out" });
      }
      if (!steps.every((result) => result.ok)) {
        runs.push({ pass, steps });
        return finish(false, false);
      }

      let until;
      try {
        until = await this.checkStepCondition(step.until, context);
      } catch (error) {
        runs.push({ pass, steps });
        return finish(false, false, {
          error: `until check failed: ${error.message}`,
        });
      }
      runs.push({ pass, steps, until });
      if (until.matched) {
        return finish(true, true);
      }
    }

    return finish(false, false, {
      error: `until did not hold after ${step.max} passes`,
    });
  }

  // Checks the then and elseIf conditions in order and runs the first branch
  // whose condition holds, or else when none does.
  async runIfStep(step, context) {
    const checked = [];
    let selected = null;
    for (const branch of step.branches) {
      const { matched, observed } = await this.checkStepCondition(
        branch.condition,
        context,
      );
      checked.push({ branch: branch.name, matched, observed });
      if (matched) {
        selected = branch;
        break;
      }
    }

    const steps = await this.executeSteps(
      selected ? selected.steps : step.else,
      context,
    );
    return {
      ok: steps.every((result) => result.ok),
      result: {
        matched: selected !== null,
        branch: selected ? selected.name : "else",
        checked,
        steps,
      },
    };
  }

  async runStep(step, context) {
    if (step.tool === "if") {
      return this.runIfStep(step, context);
    }
    if (step.tool === "repeat") {
      return this.runRepeatStep(step, context);
    }

    let result;
    if (step.tool === "sleep") {
      await sleep(step.args.ms, context.signal);
      result = { sleptMs: step.args.ms };
    } else {
      // run_tabs prepares steps before it opens their tab, so the session
      // comes from the context rather than the prepared arguments.
      // The batch reports its changes once, at the end.
      result = await this.getTools()
        .get(step.tool)
        .handler(
          { ...step.args, sessionId: context.sessionId },
          { reportChanges: false },
        );
    }

    const entry = {
      ok: true,
      result: extractStepImages(step.tool, result, context.images),
    };
    // Actions report a missing element as found: false instead of throwing;
    // later steps usually depend on it, so treat it as a failure.
    // inspect_element may be checking that something is gone.
    if (result?.found === false && step.tool !== "inspect_element") {
      entry.ok = false;
      entry.error =
        result.error ??
        `No element matches selector ${result.selector ?? step.args.selector}`;
    }
    return entry;
  }

  async executeSteps(steps, context) {
    const results = [];
    for (const [index, step] of steps.entries()) {
      // run_tabs aborts the signal when a tab times out; start nothing more.
      if (context.signal?.aborted) {
        break;
      }
      const startedAt = Date.now();
      let entry;
      try {
        entry = await this.runStep(step, context);
      } catch (error) {
        entry = { ok: false, error: error.message };
      }

      results.push({
        index,
        tool: step.tool,
        durationMs: Date.now() - startedAt,
        ...entry,
      });
      if (!entry.ok && !context.continueOnError) {
        break;
      }
    }
    return results;
  }

  // After a failed batch, reports the page and its visible controls with
  // locators, so the agent can fix the batch without looking around first.
  async describePageAfterFailure(sessionId) {
    try {
      const snapshot = await this.browserAdapter.snapshotControls(sessionId);
      if (!snapshot || !Array.isArray(snapshot.controls)) {
        return {};
      }
      return {
        page: {
          url: snapshot.url ?? null,
          title: snapshot.title ?? null,
          controls: snapshot.controls,
          moreControls: snapshot.moreControls ?? 0,
        },
      };
    } catch {
      return {};
    }
  }

  async runSteps(args) {
    const context = {
      sessionId: args.sessionId,
      continueOnError: args.continueOnError === true,
      images: [],
      count: 0,
    };
    // Validate every step, including both branches of each if, first, so a
    // typo in a late step does not leave the page half-changed.
    const steps = this.prepareSteps(args.steps, context, "arguments.steps", 0);
    const baseline =
      this.changeTracker && containsChangeReportingStep(steps)
        ? await this.changeTracker.begin(args.sessionId)
        : null;
    const results = await this.executeSteps(steps, context);
    const ok =
      results.length === steps.length && results.every((result) => result.ok);
    const changes = baseline
      ? { changes: await this.changeTracker.settle(baseline) }
      : {};

    return {
      value: {
        sessionId: args.sessionId,
        ok,
        ranSteps: results.length,
        skippedSteps: steps.length - results.length,
        steps: results,
        ...changes,
        ...(ok ? {} : await this.describePageAfterFailure(args.sessionId)),
      },
      images: context.images,
    };
  }
}

export function runStepsTool(runner) {
  return [
    "run_steps",
    {
      definition: {
        name: "run_steps",
        description: `Run session tools in order in one call: [{"tool":"type","arguments":{"selector":"ref=e3","text":"Ada"}},{"tool":"click","arguments":{"selector":"text=Save"}}]. Arguments omit sessionId. Also: sleep {ms}; if {condition, then, elseIf: [{condition, then}], else}, which branches once on wait_for fields; repeat {steps, until, max (default ${DEFAULT_REPEAT})}, which reruns steps until until holds. All steps are validated first. A step fails when it throws or reports found: false (not inspect_element); the batch stops there unless continueOnError and reports the page's controls. A batch with actions returns one changes for the whole batch. Prefer wait_for to sleep.`,
        inputSchema: runStepsInputSchema(),
      },
      handler: async (args) => runner.runSteps(args),
      formatResult: asImageToolResult,
    },
  ];
}
