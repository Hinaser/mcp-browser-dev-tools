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

### 2026-09-30: Sonnet 5.5, medium effort, with `run_steps` guidance

- **Change under test:** commit `26a3d2d` adds a recommendation to use `run_steps` to the server's `initialize` instructions, and a one-line pointer to it in the `click`, `type`, `select`, and `press_key` descriptions. This was the first "what to try next" item above.
- **Runs:** the `batch` mode only (the prompt does not mention `run_steps`), 3 runs per scenario, 9 runs in total, $0.70 in total. Same model, effort, and environment as above.

| Scenario         | Mode    | OK  | Wall time              | Turns     | Tool calls | Server time           | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | ------- | --- | ---------------------- | --------- | ---------- | --------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | `batch` | 3/3 | 9.0 s (8.4 s–11.2 s)   | 4         | 3          | 0.9 s (0.9 s–1.0 s)   | 16.9k (16.9k–16.9k) | 70.8k (70.8k–70.8k)    | 0.6k (0.6k–0.6k) | $0.051 ($0.050–$0.102) |
| `payment-retry`  | `batch` | 3/3 | 26.2 s (19.4 s–41.7 s) | 10 (6–13) | 9 (5–12)   | 14.0 s (6.6 s–23.2 s) | 7.8k (5.1k–7.8k)    | 122.4k (103.4k–159.3k) | 1.1k (0.9k–1.6k) | $0.062 ($0.052–$0.072) |
| `settings-login` | `batch` | 3/3 | 19.1 s (14.5 s–23.6 s) | 16 (7–16) | 15 (6–15)  | 0.5 s (0.4 s–1.3 s)   | 29.2k (17.5k–35.0k) | 216.5k (145.7k–236.9k) | 1.9k (1.2k–1.9k) | $0.103 ($0.091–$0.116) |

What changed compared with the first results:

1. **Every run passed.** 9 of 9.
2. **The agent now chooses `run_steps` without being asked, but not always.** It used `run_steps` in 5 of 9 runs, up from 0 of 9 before the guidance: every `signup` run, and one run each of `payment-retry` and `settings-login`.
3. **`signup` now gets most of the hinted-mode gain.** Median 9.0 s against 11.4 s in `single` mode (21% faster), 4 turns instead of 10, 16% cheaper. With the explicit hint it was 8.3 s.
4. **The other two scenarios are mixed.** Most of their runs still used single calls, so their medians barely moved: `settings-login` took 19.1 s against 20.0 s in `single` mode, within the run-to-run variation, with the same 16 turns, and `payment-retry` took 26.2 s against 19.9 s. The runs that did batch were among the fastest: 14.5 s with 7 turns for `settings-login`, and 19.4 s with 6 turns for `payment-retry`.
5. **Timed-out waits cost the most in `payment-retry`.** In the two runs that did not batch, `wait_for` calls that ended at their timeout took 13 s and 23 s of server time. The timing log does not record what a wait was waiting for, so the cause is not certain. One of those waits started after the third, successful attempt. The hinted runs above point the same way: without a wait that can end on one of several outcomes, the agent falls back to fixed sleeps or long timeouts.

Next steps:

- **Add a wait that ends on a change or on one of several outcomes**, and record each wait's condition in the timing log so timeouts like the ones above can be explained.
- **Consider more ways to get the agent to batch,** for example a short example in the instructions, then measure again. The current guidance works well when the task is a clear straight line (`signup`) and less well when the agent first wants to look around (`settings-login`).

### 2026-09-30: Sonnet 5.5, medium effort, with a `run_steps` example in the instructions

- **Change under test:** commit `9f8f548` adds an example `run_steps` call to the `initialize` instructions: a generic search flow of type, press Enter, `wait_for`, and `take_screenshot`, not one of the benchmark tasks. The instructions also now say to send the actions already known (such as every field of a form) together with the wait and the check.
- **Runs:** the `batch` mode only (no hint in the prompt), 3 runs per scenario, 9 runs in total, $0.66 in total. Same model, effort, and environment as above.

| Scenario         | Mode    | OK  | Wall time              | Turns     | Tool calls | Server time            | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | ------- | --- | ---------------------- | --------- | ---------- | ---------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | `batch` | 3/3 | 10.0 s (9.5 s–10.6 s)  | 5         | 4          | 0.9 s (0.9 s–1.0 s)    | 17.0k (17.0k–17.0k) | 74.6k (74.6k–74.6k)    | 0.7k (0.7k–0.7k) | $0.059 ($0.059–$0.059) |
| `payment-retry`  | `batch` | 3/3 | 28.9 s (28.2 s–35.0 s) | 11 (9–13) | 10 (8–12)  | 14.1 s (14.1 s–15.2 s) | 8.0k (7.6k–9.8k)    | 131.6k (104.7k–169.7k) | 1.3k (1.0k–1.5k) | $0.072 ($0.057–$0.080) |
| `settings-login` | `batch` | 3/3 | 13.7 s (13.2 s–14.9 s) | 8 (7–9)   | 7 (6–8)    | 0.8 s (0.7 s–1.2 s)    | 35.4k (23.1k–39.0k) | 147.4k (135.3k–175.3k) | 1.3k (1.2k–1.4k) | $0.093 ($0.080–$0.105) |

Median wall time, turns, and cost for each configuration so far:

| Scenario         | `single`                 | `batch-hinted`          | Guidance (`26a3d2d`)     | Guidance and example (`9f8f548`) |
| ---------------- | ------------------------ | ----------------------- | ------------------------ | -------------------------------- |
| `signup`         | 11.4 s, 10 turns, $0.060 | 8.3 s, 4 turns, $0.050  | 9.0 s, 4 turns, $0.051   | 10.0 s, 5 turns, $0.059          |
| `payment-retry`  | 19.9 s, 12 turns, $0.072 | 23.9 s, 7 turns, $0.056 | 26.2 s, 10 turns, $0.062 | 28.9 s, 11 turns, $0.072         |
| `settings-login` | 20.0 s, 16 turns, $0.103 | 16.4 s, 8 turns, $0.090 | 19.1 s, 16 turns, $0.103 | 13.7 s, 8 turns, $0.093          |

What changed:

1. **Every run passed.** 9 of 9.
2. **`run_steps` was used in 6 of 9 runs**, against 5 of 9 with the guidance alone and 0 of 9 with neither: every `signup` and `settings-login` run, and no `payment-retry` run.
3. **`settings-login` improved the most.** Every run batched the form, where only 1 of 3 did before the example. The median was 13.7 s: 31% faster than `single` mode, 8 turns instead of 16, and 10% cheaper. This beats the explicit prompt hint too (16.4 s).
4. **`signup` got slightly worse than with the guidance alone.** It still batched in every run, but every run now also took a screenshot at the start, which no run did before. That made it 10.0 s instead of 9.0 s, and brought its cost back to the `single`-mode level ($0.059 against $0.060). The example ends with a screenshot, which may have prompted this, but three runs cannot show that.
5. **`payment-retry` did not batch, and waits dominated.** Every run lost 13–15 s to `wait_for` calls that ended at their timeout, for a median of 28.9 s, 45% slower than `single` mode. No wording change helps here until a wait can end on one of several outcomes.
6. **These results are from 3 runs per scenario.** `payment-retry` in particular varies widely between runs.

Next steps:

- **Keep the example.** It raised batching and gave the biggest gain seen so far on the form-heavy scenario. The `signup` screenshot cost is small by comparison.
- **Add a wait that ends on one of several outcomes, or on a change**, and record each wait's condition in the timing log. This is now the clearest remaining cost.

### 2026-09-30: Opus 5.5, high effort

- **Model:** `claude-opus-5-5`, `--effort high`, 3 runs per scenario and mode, 18 runs in total, $2.54 in total.
- **Builds:** `single` mode ran on `857dfa3`, the benchmark commit from before the `run_steps` guidance, so its server instructions don't recommend a tool that `single` mode disallows (the same conditions as the Sonnet baseline). `batch` mode ran on `f153a94`, which has the guidance and the example. The prompt never mentions `run_steps`.
- **Environment:** same as the Sonnet runs above.

| Build     | Scenario         | Mode     | OK  | Wall time              | Turns      | Tool calls | Server time          | Response chars      | Input tokens           | Output tokens    | Cost                   |
| --------- | ---------------- | -------- | --- | ---------------------- | ---------- | ---------- | -------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `857dfa3` | `signup`         | `single` | 3/3 | 18.7 s (18.6 s–18.8 s) | 11         | 10         | 0.6 s (0.5 s–0.6 s)  | 13.3k (13.3k–13.3k) | 104.4k (104.3k–104.4k) | 1.3k (1.2k–1.3k) | $0.113 ($0.111–$0.207) |
| `857dfa3` | `payment-retry`  | `single` | 1/3 | 25.9 s (25.7 s–59.3 s) | 9 (9–11)   | 8 (8–10)   | 1.4 s (1.3 s–36.0 s) | 12.4k (11.1k–12.4k) | 119.2k (119.2k–137.5k) | 1.7k (1.5k–1.7k) | $0.120 ($0.120–$0.121) |
| `857dfa3` | `settings-login` | `single` | 3/3 | 29.8 s (28.8 s–44.5 s) | 17 (16–17) | 16 (15–16) | 0.1 s (0.1 s–0.3 s)  | 16.9k (16.8k–17.6k) | 226.2k (187.1k–249.6k) | 2.1k (1.9k–2.2k) | $0.164 ($0.164–$0.177) |
| `f153a94` | `signup`         | `batch`  | 3/3 | 12.4 s (12.0 s–13.0 s) | 4 (4–5)    | 3 (3–4)    | 0.9 s (0.9 s–1.0 s)  | 18.5k (18.5k–19.9k) | 72.6k (72.1k–75.7k)    | 0.7k (0.6k–0.7k) | $0.111 ($0.093–$0.201) |
| `f153a94` | `payment-retry`  | `batch`  | 3/3 | 24.5 s (23.8 s–29.0 s) | 8 (6–11)   | 7 (5–10)   | 1.5 s (1.3 s–4.0 s)  | 17.5k (14.2k–20.0k) | 150.1k (111.4k–188.0k) | 1.5k (1.2k–1.8k) | $0.132 ($0.118–$0.145) |
| `f153a94` | `settings-login` | `batch`  | 3/3 | 21.2 s (20.7 s–33.1 s) | 7 (7–8)    | 6 (6–7)    | 1.2 s (1.2 s–1.3 s)  | 26.8k (26.7k–26.9k) | 139.7k (139.3k–140.2k) | 1.3k (1.3k–1.4k) | $0.148 ($0.145–$0.149) |

Median wall time and cost next to the Sonnet 5.5 results:

| Scenario         | Sonnet `single` | Sonnet `batch` with example | Opus `single`                  | Opus `batch` with example |
| ---------------- | --------------- | --------------------------- | ------------------------------ | ------------------------- |
| `signup`         | 11.4 s, $0.060  | 10.0 s, $0.059              | 18.7 s, $0.113                 | 12.4 s, $0.111            |
| `payment-retry`  | 19.9 s, $0.072  | 28.9 s, $0.072              | 25.9 s, $0.120 (1 of 3 passed) | 24.5 s, $0.132            |
| `settings-login` | 20.0 s, $0.103  | 13.7 s, $0.093              | 29.8 s, $0.164                 | 21.2 s, $0.148            |

What the numbers show:

1. **Opus used `run_steps` in every `batch` run** (9 of 9) without being asked, against 6 of 9 for Sonnet with the same instructions.
2. **Batching cut Opus's time by about a third on the form scenarios.** `signup` was 34% faster than `single` mode (18.7 s to 12.4 s, 11 turns to 4). `settings-login` was 29% faster (29.8 s to 21.2 s, 17 turns to 7) and 10% cheaper. `signup` cost stayed about the same, at $0.111 against $0.113.
3. **Opus handled the payment waits better when batching.** All 3 `batch` runs passed, with a median of 1.5 s of server time (at most 4.0 s) and no long waits, against 13–15 s per run lost to timed-out waits for Sonnet.
4. **In `single` mode, Opus gave up on the payment in 2 of 3 runs.** After two "card declined" responses, it stopped and reported that it couldn't pay instead of trying a third time, although the task says a payment may fail temporarily. This is the model's judgment about a card decline, not a tool failure, and no Sonnet run did it. A clearer error message on the fixture page (for example "temporarily unavailable") would separate the two, at the cost of comparability with the runs above.
5. **Opus is slower and costs more per task than Sonnet here.** It cost 1.6–1.9 times as much in every scenario and mode. It took 1.2–1.6 times as long, with one exception: `payment-retry` in `batch` mode, where Opus was faster because Sonnet lost time to timed-out waits. The turn counts were similar (within 1 turn, except in `payment-retry`), so the extra time goes into each turn. Model time was a median 90% of wall time.
6. **The first run of each series costs about $0.20**, because it writes about 21k tokens to the prompt cache. The medians hide this, and the ranges show it.
