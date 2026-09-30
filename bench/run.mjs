// Runs the benchmark scenarios through headless Claude Code (or the Codex
// CLI for gpt-* models) against a throwaway headless Chrome, and appends one
// JSON line per run to bench/results/. See PERFORMANCE.md for the method.
//
//   node bench/run.mjs --model claude-sonnet-5-5 --effort medium --repeats 3
//   node bench/run.mjs --model gpt-6.1-sol --effort medium --modes batch

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { startFixtureServer } from "./fixture-server.mjs";
import { SCENARIOS, scenarioPrompt } from "./scenarios.mjs";

const REPO_ROOT = new URL("../", import.meta.url);
const SERVER_NAME = "browser";
const MODES = {
  // Only single-action tools: every check needs its own round trip, and
  // every tab its own calls.
  single: {
    args: [
      "--disallowedTools",
      `mcp__${SERVER_NAME}__run_steps`,
      `mcp__${SERVER_NAME}__run_tabs`,
    ],
  },
  // run_steps and run_tabs are available; the prompt does not ask for them.
  batch: { args: [] },
  // run_steps is available and the prompt asks the agent to prefer it.
  "batch-hinted": {
    args: [],
    hint: "Prefer the run_steps tool: combine each action with the waits and checks that follow it, and use its if steps when the page can be in more than one state, so that one call does what would otherwise take several.",
  },
};

const { values: options } = parseArgs({
  options: {
    model: { type: "string" },
    effort: { type: "string", default: "medium" },
    repeats: { type: "string", default: "3" },
    scenarios: {
      type: "string",
      default: SCENARIOS.map((s) => s.id).join(","),
    },
    modes: { type: "string", default: Object.keys(MODES).join(",") },
    chrome: {
      type: "string",
      default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    "cdp-port": { type: "string", default: "9333" },
    "timeout-ms": { type: "string", default: "300000" },
    out: { type: "string" },
    // Directory to save each run's stream-json transcript in, for reading
    // the exact tool arguments afterwards.
    transcripts: { type: "string" },
  },
});

if (!options.model) {
  throw new Error("--model is required, for example --model claude-sonnet-5-5");
}

const scenarios = options.scenarios.split(",").map((id) => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`Unknown scenario ${id}`);
  }
  return scenario;
});
const modes = options.modes.split(",");
const isCodex = options.model.startsWith("gpt-");
if (isCodex && modes.includes("single")) {
  throw new Error("single mode is not supported for Codex runs yet");
}
for (const mode of modes) {
  if (!MODES[mode]) {
    throw new Error(`Unknown mode ${mode}`);
  }
}

const cdpOrigin = `http://127.0.0.1:${options["cdp-port"]}`;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

async function cdpAnswers() {
  try {
    const response = await fetch(`${cdpOrigin}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(Number(port), "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function startChrome(workDir) {
  // Refuse a port that is already taken, so the run never drives someone
  // else's browser.
  if (!(await portIsFree(options["cdp-port"]))) {
    throw new Error(
      `Port ${options["cdp-port"]} is already in use; pass --cdp-port with a free port`,
    );
  }
  const profile = path.join(workDir, "chrome-profile");
  const chrome = spawn(
    options.chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${options["cdp-port"]}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = null;
  chrome.on("error", (error) => {
    exited = error.message;
  });
  chrome.on("exit", (code, signal) => {
    exited = `exit ${signal ?? code}`;
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (exited) {
      throw new Error(`Chrome stopped before exposing ${cdpOrigin}: ${exited}`);
    }
    if (await cdpAnswers()) {
      return chrome;
    }
    await sleep(200);
  }
  chrome.kill();
  throw new Error(`Chrome did not expose ${cdpOrigin}`);
}

async function openTab(url) {
  const response = await fetch(
    `${cdpOrigin}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  return (await response.json()).id;
}

async function closeTab(targetId) {
  await fetch(`${cdpOrigin}/json/close/${targetId}`).catch(() => {});
}

function runClaude({ prompt, mode, runDir, mcpConfigPath }) {
  const args = [
    "-p",
    prompt,
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    // Keep the maintainer's own CLAUDE.md, settings, and MCP servers out.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--tools",
    "",
    "--allowedTools",
    `mcp__${SERVER_NAME}`,
    ...MODES[mode].args,
  ];

  return runAgent("claude", args, runDir);
}

function runAgent(command, args, runDir) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: runDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, Number(options["timeout-ms"]));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

// GPT models run through the Codex CLI, isolated like the Claude runs: no
// user config, no built-in browser, shell, web, or app tools, and only this
// server. Codex keeps an exec tool, which the read-only sandbox confines.
const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "apps",
  "plugins",
  "image_generation",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
  "goals",
];

// OpenAI API standard-tier list prices in USD per 1M tokens, short context,
// from developers.openai.com/api/docs/pricing on 2026-09-30. Codex under a
// ChatGPT login reports tokens but no cost, so GPT costs are estimates.
const OPENAI_PRICES = {
  "gpt-6-astra": {
    input: 10.0,
    cachedInput: 1.0,
    cacheWrite: 12.5,
    output: 50.0,
  },
  "gpt-6.1-sol": {
    input: 2.0,
    cachedInput: 0.1,
    cacheWrite: 2.5,
    output: 10.0,
  },
  "gpt-6-luna": {
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
  },
};

// Output tokens include reasoning tokens, which are billed as output.
function estimateOpenAiCost(model, usage) {
  const price = OPENAI_PRICES[model];
  if (!price) {
    return null;
  }
  return (
    (usage.input_tokens * price.input +
      usage.cache_read_input_tokens * price.cachedInput +
      usage.cache_creation_input_tokens * price.cacheWrite +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

function tomlString(value) {
  return JSON.stringify(value);
}

function runCodex({ prompt, runDir, timingLog }) {
  const env = {
    MCP_BROWSER_FAMILY: "chromium",
    CDP_BASE_URL: cdpOrigin,
    MCP_BROWSER_TIMING_LOG: timingLog,
  };
  const args = [
    "exec",
    "--model",
    options.model,
    "-c",
    `model_reasoning_effort=${tomlString(options.effort)}`,
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--cd",
    runDir,
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c",
    'web_search="disabled"',
    "-c",
    `mcp_servers.${SERVER_NAME}.command=${tomlString(process.execPath)}`,
    "-c",
    `mcp_servers.${SERVER_NAME}.args=[${tomlString(fileURLToPath(new URL("cli.mjs", REPO_ROOT)))},"serve"]`,
    "-c",
    `mcp_servers.${SERVER_NAME}.default_tools_approval_mode="approve"`,
    "-c",
    `mcp_servers.${SERVER_NAME}.env={${Object.entries(env)
      .map(([key, value]) => `${key}=${tomlString(value)}`)
      .join(",")}}`,
    prompt,
  ];
  return runAgent("codex", args, runDir);
}

// Codex prints one JSON event per line. Its usage counts cached input inside
// input_tokens, and it reports neither turns nor cost, so turns are counted
// as tool calls plus the final answer.
function parseCodexStream(stdout) {
  const toolCalls = {};
  let reply = null;
  const usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let completed = false;
  const errors = [];
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item;
    if (event.type === "item.completed" && item) {
      if (item.type === "agent_message") {
        reply = item.text ?? reply;
      } else if (item.type === "mcp_tool_call") {
        toolCalls[item.tool] = (toolCalls[item.tool] ?? 0) + 1;
      } else if (item.type === "error") {
        errors.push(item.message);
      } else if (item.type !== "reasoning") {
        toolCalls[item.type] = (toolCalls[item.type] ?? 0) + 1;
      }
    }
    if (event.type === "turn.failed" || event.type === "error") {
      errors.push(event.error?.message ?? event.message ?? event.type);
    }
    if (event.type === "turn.completed") {
      completed = true;
      usage.input += event.usage?.input_tokens ?? 0;
      usage.cached += event.usage?.cached_input_tokens ?? 0;
      usage.cacheWrite += event.usage?.cache_write_input_tokens ?? 0;
      usage.output += event.usage?.output_tokens ?? 0;
      usage.reasoning += event.usage?.reasoning_output_tokens ?? 0;
    }
  }
  const calls = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  return {
    toolCalls,
    error: errors.join("; ") || null,
    result: completed
      ? {
          result: reply ?? "",
          num_turns: calls + 1,
          usage: {
            input_tokens: usage.input - usage.cached - usage.cacheWrite,
            cache_creation_input_tokens: usage.cacheWrite,
            cache_read_input_tokens: usage.cached,
            output_tokens: usage.output,
            reasoning_output_tokens: usage.reasoning,
          },
        }
      : null,
  };
}

function parseStream(stdout) {
  const toolCalls = {};
  let result = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          const name = block.name.replace(`mcp__${SERVER_NAME}__`, "");
          toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        }
      }
    }
    if (event.type === "result") {
      result = event;
    }
  }
  return { toolCalls, result };
}

async function readTimingLog(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return {
      calls: 0,
      ms: 0,
      responseChars: 0,
      images: 0,
      batchedSteps: 0,
      entries: [],
    };
  }
  const entries = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    calls: entries.length,
    ms: entries.reduce((total, entry) => total + entry.ms, 0),
    responseChars: entries.reduce(
      (total, entry) => total + entry.responseChars,
      0,
    ),
    images: entries.reduce((total, entry) => total + entry.images, 0),
    batchedSteps: entries.reduce(
      (total, entry) => total + (entry.steps ?? 0),
      0,
    ),
    // Per call, so outliers such as a timed-out wait can be explained later.
    entries: entries.map(({ tool, ms, ok, stepsOk }) => ({
      tool,
      ms,
      ok,
      ...(stepsOk === undefined ? {} : { stepsOk }),
    })),
  };
}

const workDir = await mkdtemp(path.join(tmpdir(), "mcp-browser-bench-"));
const resultsDir = new URL("results/", import.meta.url);
await mkdir(resultsDir, { recursive: true });
const outFile =
  options.out ??
  new URL(
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.model}-${options.effort}.jsonl`,
    resultsDir,
  ).pathname;
const commit = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain", "--", "src"]) !== "";
const packageVersion = JSON.parse(
  await readFile(new URL("package.json", REPO_ROOT), "utf8"),
).version;

const fixtures = await startFixtureServer({
  fixturesDir: new URL("fixtures/", import.meta.url),
});
const chrome = await startChrome(workDir);
const chromeVersion = await (await fetch(`${cdpOrigin}/json/version`)).json();

try {
  const total = Number(options.repeats) * scenarios.length * modes.length;
  let index = 0;
  for (let repeat = 1; repeat <= Number(options.repeats); repeat += 1) {
    for (const scenario of scenarios) {
      for (const mode of modes) {
        index += 1;
        const run = randomBytes(6).toString("hex");
        const runDir = path.join(workDir, run);
        await mkdir(runDir);
        const timingLog = path.join(runDir, "timing.jsonl");
        const mcpConfigPath = path.join(runDir, "mcp.json");
        await writeFile(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: {
              [SERVER_NAME]: {
                command: process.execPath,
                args: [fileURLToPath(new URL("cli.mjs", REPO_ROOT)), "serve"],
                env: {
                  MCP_BROWSER_FAMILY: "chromium",
                  CDP_BASE_URL: cdpOrigin,
                  MCP_BROWSER_TIMING_LOG: timingLog,
                },
              },
            },
          }),
        );

        const url = `${fixtures.origin}${scenario.path}?run=${run}`;
        const targetId = await openTab(url);
        const prompt = scenarioPrompt(scenario, {
          url,
          targetId,
          hint: MODES[mode].hint,
        });
        const startedAt = Date.now();
        const claude = isCodex
          ? await runCodex({ prompt, runDir, timingLog })
          : await runClaude({ prompt, mode, runDir, mcpConfigPath });
        const wallMs = Date.now() - startedAt;
        await closeTab(targetId);
        if (options.transcripts) {
          await mkdir(options.transcripts, { recursive: true });
          await writeFile(
            path.join(
              options.transcripts,
              `${index}-${scenario.id}-${mode}-${repeat}.jsonl`,
            ),
            claude.stdout,
          );
        }

        const { toolCalls, result, error } = isCodex
          ? parseCodexStream(claude.stdout)
          : parseStream(claude.stdout);
        const reply = result?.result ?? "";
        const verdict = result
          ? scenario.check({ state: fixtures.state(run), reply })
          : {
              ok: false,
              detail: `no result (exit ${claude.exitCode}): ${(error ?? claude.stderr).slice(0, 200)}`,
            };
        const usage = result?.usage ?? {};
        const record = {
          date: new Date(startedAt).toISOString(),
          commit,
          dirty,
          packageVersion,
          chrome: chromeVersion.Browser,
          agent: isCodex ? "codex" : "claude",
          model: options.model,
          effort: options.effort,
          scenario: scenario.id,
          mode,
          repeat,
          ok: verdict.ok,
          detail: verdict.detail,
          wallMs,
          durationMs: result?.duration_ms ?? null,
          durationApiMs: result?.duration_api_ms ?? null,
          numTurns: result?.num_turns ?? null,
          costUsd: isCodex
            ? result
              ? estimateOpenAiCost(options.model, usage)
              : null
            : (result?.total_cost_usd ?? null),
          ...(isCodex ? { costEstimated: true } : {}),
          tokens: {
            input: usage.input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            ...(isCodex
              ? { reasoning: usage.reasoning_output_tokens ?? 0 }
              : {}),
          },
          toolCalls,
          server: await readTimingLog(timingLog),
          reply: reply.slice(0, 200),
        };
        await appendFile(outFile, `${JSON.stringify(record)}\n`);
        console.log(
          `[${index}/${total}] ${scenario.id} ${mode} #${repeat}: ${record.ok ? "ok" : "FAIL"} ${(wallMs / 1000).toFixed(1)}s turns=${record.numTurns} calls=${Object.values(toolCalls).reduce((a, b) => a + b, 0)} ${record.detail}`,
        );
      }
    }
  }
} finally {
  chrome.kill();
  await fixtures.close();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`results: ${path.relative(process.cwd(), outFile)}`);
