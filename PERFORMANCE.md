# Performance

This file records how fast an AI agent completes browser tasks through this MCP server, and what it costs. It explains the method, lists the test scenarios, and keeps a dated log of results, one section per model and effort level.

## What is measured

Two layers are measured separately, because they answer different questions.

- **Server time.** How long each tool call takes inside the broker. With `MCP_BROWSER_TIMING_LOG=<file>` set, the server appends one JSON line per tool call: the tool name, duration, whether it returned, and the size of the response (text characters and image count). `run_steps` entries also carry the number of steps it ran and whether they all succeeded. This layer does not depend on the model.
- **End-to-end runs.** How long an agent takes to finish a whole task, how many turns and tool calls it needs, and how many tokens and dollars that costs. Most of this time is the model thinking between calls, so it depends on the model and effort level.

## Method

`bench/run.mjs` runs every scenario through headless Claude Code, with a fresh MCP server per run.

- **Browser.** A throwaway headless Chrome with its own temporary profile, on port 9333, so benchmark runs never touch a real profile.
- **Pages.** `bench/fixture-server.mjs` serves the fixture pages from `bench/fixtures/` on loopback, with no network access. It keeps per-run state (what was submitted, how many attempts were made) so a run can be judged by what actually happened on the page.
- **Agent.** `claude -p` with `--model` and `--effort`, isolated from the machine it runs on: `--setting-sources ""` (no user or project `CLAUDE.md` or settings), `--strict-mcp-config` with only this server, `--tools ""` (no built-in tools such as Bash or Read), and `--allowedTools mcp__browser`. The runner opens the tab and gives the agent its URL and target id.
- **Modes.**
  - `single`: `run_steps` is disallowed, so every action and check is its own tool call.
  - `batch`: `run_steps` is available, but the prompt does not mention it.
  - `batch-hinted`: `run_steps` is available, and the prompt asks the agent to prefer it (the exact wording is `MODES` in `bench/run.mjs`).
- **Success.** Each scenario's `check` in `bench/scenarios.mjs` passes only if the fixture server recorded the right outcome (for example, the exact signup values, or a completed payment with no overlapping attempts) and the agent's reply contains the code the page showed at the end.
- **Repeats.** Model runs vary, so each scenario and mode runs several times. The tables show the median, with the range in parentheses when runs differ.

Metrics in the tables:

- **Wall time**: from starting `claude -p` until it exits.
- **Turns**: model turns reported by Claude Code.
- **Tool calls**: browser tool calls made by the agent.
- **Server time**: total time the server spent inside tool calls.
- **Response chars**: total text returned by the tools, a rough measure of how much the tools add to the context.
- **Input tokens**: uncached, cache-write, and cache-read input tokens added together.
- **Cost**: the `total_cost_usd` Claude Code reports.

### Running it

```sh
node bench/run.mjs --model claude-sonnet-5-5 --effort medium --repeats 3
node bench/run.mjs --model claude-sonnet-5-5 --effort medium --modes batch-hinted
node bench/summarize.mjs bench/results/*.jsonl
```

`--scenarios` and `--modes` take comma-separated lists. Raw results go to `bench/results/`, which is not committed; each line records the build, model, effort, Chrome version, verdict, timings, token usage, tool calls, and (since the `batch-hinted` runs below) the per-call server timings. The runner needs macOS Chrome at its default path, or `--chrome <path>`, and a logged-in `claude` CLI.

## Scenarios

The source of truth is `bench/scenarios.mjs` (task prompts and success checks) and `bench/fixtures/` (the pages). Every prompt starts with the tab's URL and target id and asks the agent to attach to it and not open other tabs.

| Id               | What the agent must do                                                                                                                                                                                                                                       | Passes when                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup`         | Dismiss a cookie banner that covers the form 500 ms after load, fill in the name, email, and plan select, tick the terms checkbox, submit, wait for the account to be created (800 ms), and report the confirmation code.                                    | The server recorded exactly "Ada Lovelace", `ada@example.com`, the Pro plan, and accepted terms, and the reply contains the confirmation code. |
| `payment-retry`  | Pay, see the first two attempts get declined (1.2 s each), retry without starting a new attempt while one is processing, and report the receipt number from the third attempt.                                                                               | The payment completed, no attempts overlapped, and the reply contains the receipt number.                                                      |
| `settings-login` | Open settings, get redirected to a login form, sign in, come back, turn email notifications off and the weekly digest on, set the language to Japanese, save (600 ms), and report the revision shown after saving. The "saved" toast disappears after 2.5 s. | The saved settings match, and the reply contains the latest revision number.                                                                   |

## Results

### 2026-09-30: Sonnet 5.5, medium effort

- **Model:** `claude-sonnet-5-5`, `--effort medium`, 3 runs per scenario and mode, 27 runs in total, $2.03 in total.
- **Build:** commit `0a3318d` plus the uncommitted timing log (shown as `0a3318d*` by `summarize.mjs`).
- **Environment:** Chrome 154 headless, Node.js 24.20, macOS 26.6 on Apple Silicon.
- **Fixture change between modes:** the `single` and `batch` runs used the fixtures from before two small fixes. The signup page now also sends the terms checkbox to the server, and a payment attempt now decides its outcome by its own attempt number. Neither fix changes what an agent sees or has to do in these flows.

| Scenario         | Mode           | OK  | Wall time              | Turns      | Tool calls | Server time           | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | -------------- | --- | ---------------------- | ---------- | ---------- | --------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | `single`       | 3/3 | 11.4 s (11.0 s–12.1 s) | 10         | 9          | 0.3 s (0.3 s–0.6 s)   | 13.1k (13.1k–13.1k) | 84.4k (84.4k–84.5k)    | 1.1k (1.1k–1.1k) | $0.060 ($0.059–$0.105) |
| `signup`         | `batch`        | 3/3 | 14.2 s (11.3 s–14.8 s) | 11         | 10         | 0.5 s (0.5 s–0.6 s)   | 13.3k (13.2k–13.3k) | 95.2k (95.2k–110.8k)   | 1.2k (1.2k–1.2k) | $0.069 ($0.066–$0.069) |
| `signup`         | `batch-hinted` | 3/3 | 8.3 s (8.1 s–8.4 s)    | 4          | 3          | 0.9 s (0.9 s–0.9 s)   | 16.9k (16.9k–16.9k) | 70.1k (70.1k–70.2k)    | 0.6k (0.6k–0.6k) | $0.050 ($0.050–$0.050) |
| `payment-retry`  | `single`       | 3/3 | 19.9 s (15.9 s–26.1 s) | 12 (9–12)  | 11 (8–11)  | 1.1 s (0.9 s–14.0 s)  | 9.7k (7.7k–11.6k)   | 136.3k (110.9k–136.7k) | 1.5k (1.0k–1.5k) | $0.072 ($0.058–$0.073) |
| `payment-retry`  | `batch`        | 3/3 | 14.2 s (14.0 s–27.5 s) | 10 (10–11) | 9 (9–10)   | 0.2 s (0.0 s–13.9 s)  | 9.0k (7.9k–9.4k)    | 144.0k (120.9k–144.4k) | 1.3k (1.2k–1.4k) | $0.069 ($0.062–$0.071) |
| `payment-retry`  | `batch-hinted` | 3/3 | 23.9 s (21.6 s–27.3 s) | 7 (6–11)   | 6 (5–10)   | 13.1 s (8.0 s–13.6 s) | 8.0k (7.6k–8.2k)    | 119.9k (102.5k–121.2k) | 1.0k (1.0k–1.3k) | $0.056 ($0.053–$0.065) |
| `settings-login` | `single`       | 3/3 | 20.0 s (19.4 s–20.4 s) | 16 (16–17) | 15 (15–16) | 0.3 s (0.1 s–0.3 s)   | 17.6k (15.3k–29.2k) | 201.8k (179.5k–224.0k) | 1.9k (1.8k–2.0k) | $0.103 ($0.096–$0.106) |
| `settings-login` | `batch`        | 3/3 | 17.5 s (15.9 s–19.3 s) | 15 (15–16) | 14 (14–15) | 0.3 s (0.1 s–0.3 s)   | 29.1k (15.3k–29.1k) | 164.5k (164.0k–214.9k) | 1.7k (1.7k–1.9k) | $0.098 ($0.097–$0.099) |
| `settings-login` | `batch-hinted` | 3/3 | 16.4 s (15.0 s–19.3 s) | 8 (7–9)    | 7 (6–8)    | 1.6 s (0.6 s–2.1 s)   | 26.3k (22.2k–37.6k) | 149.9k (138.2k–180.6k) | 1.4k (1.4k–1.5k) | $0.090 ($0.085–$0.098) |

What the numbers show:

1. **Every run passed.** 27 of 27 runs completed the task correctly.
2. **The model's time dominates, not the browser's.** Across all runs, the median share of wall time spent in model API calls was 87%. Browser operations took about 2 s of server time per run or less, except where the agent chose to wait (a long `wait_for` or `sleep`). Making the tools faster would barely help; needing fewer turns does.
3. **Without a hint, Sonnet did not use `run_steps`.** In the `batch` mode it never called `run_steps` in any of the 9 runs, so `single` and `batch` measured the same behavior. Their differences, up to 5.7 s in median wall time (`payment-retry`, where one run in each mode waited about 14 s on the server), show how much results vary between runs of the same behavior.
4. **When it batches, turns drop by 42–60%.** In `batch-hinted`, the agent used `run_steps` in 8 of 9 runs:
   - `signup`: 11.4 s to 8.3 s (27% faster), 10 turns to 4, cost 17% lower.
   - `settings-login`: 20.0 s to 16.4 s (18% faster), 16 turns to 8, cost 13% lower.
   - `payment-retry`: 12 turns to 7 and cost 22% lower, but 19.9 s to 23.9 s, 20% slower. Its batches took 2–6 s each, mostly fixed `sleep` steps waiting for the payment to finish, because a `wait_for` condition cannot say "until the status is no longer Processing" or "until it says either Paid or failed". Those fixed sleeps account for the 13 s of server time.
5. **Every run used `evaluate_js`** (median 2 calls per run), mostly to read the page structure before acting.
6. **Tool definitions are most of the input tokens.** A turn used a median of about 12.3k input tokens, 93% of which were cache reads. The tool list alone is about 33.7k characters (36 tools; `run_steps` has the longest definition at 3.1k characters) and is sent on every turn. So input tokens grow with the number of turns more than with page content. `get_document` is the exception: a single call roughly doubled the response size in the `settings-login` runs that used it.

What to try next, based on these results:

- **Make `run_steps` easier to discover without a prompt hint**, for example by mentioning it in the server's `initialize` instructions, which Claude Code shows to the model. Then rerun the `batch` mode.
- **Let a wait end on a change or on one of several outcomes**, for example a `textExcludes` condition or a list of alternative conditions, so flows like `payment-retry` don't need fixed sleeps inside a batch.
- **Shorten the tool definitions.** They are paid for on every turn.
- **Consider a compact page-text tool** to replace the opening `evaluate_js` or `get_document` read.
