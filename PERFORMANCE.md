# Performance

How fast an AI agent finishes browser tasks through this MCP server, and what it costs. Every number here is for the current server, build `38d4ed2`, measured on 2026-10-04 with Chrome 154 headless, Node.js 24.20, and macOS 26.6 on Apple Silicon. Earlier builds' numbers are in this file's history.

Seven models at medium effort ran the four [scenarios](#scenarios) 3 times each with the full tool set (`batch` mode), and Sonnet 5.5 ran them again with one action per call (`single` mode): 96 runs, 95 passed, $14.00 in total. Each chart bar is the median of 3 runs, or for a model's bar, the average over the scenarios of each scenario's median.

## Model comparison

![Wall time per task by model](docs/images/bench-model-wall-time.svg)

![Cost per task by model, in US cents](docs/images/bench-model-cost.svg)

![Model turns per task by model](docs/images/bench-model-turns.svg)

Per task: the average over the four scenarios of each scenario's median wall time, turns, and cost; then each scenario's median wall time · turns · cost.

| Model       | Via         | OK    | Wall time | Turns | Cost     | `signup`              | `payment-retry`        | `settings-login`       | `research`            |
| ----------- | ----------- | ----- | --------- | ----- | -------- | --------------------- | ---------------------- | ---------------------- | --------------------- |
| Fable 5.1   | Claude Code | 12/12 | 23.2 s    | 5.8   | $0.273   | 13.6 s · 5 · $0.249   | 21.4 s · 6 · $0.243    | 46.0 s · 8 · $0.364    | 11.7 s · 4 · $0.234   |
| Opus 5.5    | Claude Code | 12/12 | 15.7 s    | 6.5   | $0.104   | 12.8 s · 6 · $0.093   | 21.6 s · 8 · $0.121    | 17.0 s · 8 · $0.119    | 11.4 s · 4 · $0.081   |
| Sonnet 5.5  | Claude Code | 12/12 | 14.6 s    | 7.0   | $0.063   | 9.7 s · 5 · $0.057    | 27.0 s · 12 · $0.068   | 12.7 s · 7 · $0.082    | 9.0 s · 4 · $0.047    |
| Haiku 4.5   | Claude Code | 11/12 | 38.2 s    | 13.5  | $0.074   | 32.8 s · 7 · $0.058   | 27.5 s · 7 · $0.051    | 34.3 s · 9 · $0.055    | 58.2 s · 31 · $0.131  |
| GPT-6-Astra | Codex CLI   | 12/12 | 44.1 s    | 7.2   | $0.433\* | 34.5 s · 5 · $0.362\* | 47.4 s · 12 · $0.495\* | 62.2 s · 7 · $0.514\*  | 32.3 s · 5 · $0.361\* |
| GPT-6.1 Sol | Codex CLI   | 12/12 | 37.3 s    | 6.2   | $0.077\* | 31.9 s · 5 · $0.076\* | 47.4 s · 8 · $0.069\*  | 41.2 s · 7 · $0.093\*  | 28.8 s · 5 · $0.071\* |
| GPT-6-Luna  | Codex CLI   | 12/12 | 33.3 s    | 9.0   | $0.006\* | 30.8 s · 8 · $0.005\* | 36.0 s · 11 · $0.007\* | 43.3 s · 11 · $0.007\* | 22.9 s · 6 · $0.005\* |

\* Estimated from OpenAI's standard list prices, because Codex under a ChatGPT login reports tokens but no cost.

1. **Sonnet 5.5 and Opus 5.5 are the fastest, at 14.6 s and 15.7 s per task.** Sonnet is the cheapest model per task here apart from GPT-6-Luna ($0.063; Haiku's $0.074 is pulled up by its `research` runs) and the fastest per turn (2.1 s); Opus needs slightly fewer turns at 1.7 times the cost.
2. **Fable 5.1 takes the fewest turns (5.8) but 23.2 s per task at 2.6 times Opus's cost.** Its turns are long: `settings-login` took 46 s in 8 turns with 0.1 s of server time, all of it model time. It gained nothing over Opus on these tasks.
3. **Fable and Opus retried the payment inside one `repeat` step in every run** and finished `payment-retry` in 6 and 8 turns; GPT-6-Luna did in 1 of 3 runs, and no other model did. Sonnet handles each attempt in its own turns (12).
4. **Every model started every form task with `get_snapshot`** and acted by ref. Opus and Luna also use it as the check at the end of a batch. Haiku 4.5 is the only model that also takes screenshots (24 across its 12 runs), and it lost time to batches that failed partway and to timed-out waits: 6–13 s of server time per form task.
5. **Haiku 4.5 is the slowest Claude model and had the only failure.** No `research` run used `run_tabs`: all three opened the articles one at a time, in 18–31 turns and 49–68 s, and one of them, which clicked each link and took a screenshot after it, reported 1 of 5 codenames.
6. **The GPT models are slower per turn**: 5.7–6.0 s for GPT-6.1 Sol and GPT-6-Astra and 4.2 s for GPT-6-Luna, against 2.1–3.9 s for the Claude models, so they take 33–44 s per task on 6–9 turns. The Codex CLI's own startup accounts for 4–9 s of each run (see [Method](#method)).
7. **GPT-6-Astra is the most expensive**, an estimated $0.433 per task. In 2 of its 3 `settings-login` runs, Chrome delivered none of the clicks sent right after the login redirect; the tools reported that the input had no effect instead of success, and Astra finished the form with `evaluate_js`. That is the dropped-input case the delivery check was added for, and it has only ever been seen in Astra runs.
8. **GPT-6.1 Sol's estimated cost is close to Sonnet's ($0.077), and GPT-6-Luna's is about a tenth of Haiku's ($0.006)**, with every run passing. Luna takes the most turns of the GPT models (9) and reads `get_document` where the others do not.

## Batching

Sonnet 5.5 with one action per call (`single`: `run_steps` and `run_tabs` disallowed) against Sonnet and Opus with the full tool set:

![Wall time per scenario: Sonnet single, Sonnet batch, and Opus batch](docs/images/bench-wall-time.svg)

![Model turns per scenario](docs/images/bench-turns.svg)

![Cost per scenario in US cents](docs/images/bench-cost.svg)

1. **Batching halves the turns.** With `run_steps`, Sonnet's `signup` takes 5 turns instead of 11 and `settings-login` 7 instead of 14; with `run_tabs`, `research` takes 4 instead of 7. Every `batch` run of `signup` and `settings-login` sent each form as one batch, and every `research` run opened the five articles in one `run_tabs` call. Wall time follows: 9.7 s against 15.9 s, 12.7 s against 20.5 s, and 9.0 s against 28.1 s.
2. **Model time is most of the wall time.** Server time is under 2 s per task except where a wait ran to its timeout, so needing fewer turns matters far more than faster tools.
3. **`payment-retry` is decided by how the agent waits.** The page has one button, so the snapshot saves nothing. Sonnet's `batch` median of 27.0 s hides one run that lost 20 s to a `wait_for` on `#pay` with `textExcludes: "Processing"` that reached its timeout; the `single` runs (16.3 s) happened not to.
4. **Without `run_tabs`, agents look for a shortcut.** Every `single` run of `research` first tried to `fetch()` the articles from the page with `evaluate_js`, which the browser blocks across origins, then navigated to them one by one; one run took 14 turns and 34 s.
5. **Tool definitions are most of the input tokens.** The 39 tool definitions are 33.0k characters, sent (and cached) on every turn, so cost grows with turns more than with page content. A `get_snapshot` of the settings page is 6 lines; the same page from `get_document` is several kilobytes.

## Results

Median of 3 runs, with the range in parentheses when runs differ. The column meanings are under [Method](#method).

### Sonnet 5.5, medium effort, `single` mode

| Scenario         | OK  | Wall time              | Turns      | Tool calls | Server time          | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | ---------- | ---------- | -------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 15.9 s (12.4 s–17.1 s) | 11 (11–12) | 10 (10–11) | 0.1 s (0.1 s–0.1 s)  | 9.7k (9.0k–12.4k)   | 100.9k (99.9k–117.6k)  | 1.1k (1.1k–1.2k) | $0.063 ($0.061–$0.108) |
| `payment-retry`  | 3/3 | 16.3 s (13.2 s–44.1 s) | 13 (12–13) | 12 (11–12) | 1.8 s (0.4 s–30.7 s) | 9.0k (7.1k–12.8k)   | 116.4k (113.1k–161.5k) | 1.3k (1.3k–1.5k) | $0.070 ($0.065–$0.075) |
| `settings-login` | 3/3 | 20.5 s (15.0 s–21.3 s) | 14 (13–15) | 13 (12–14) | 0.1 s (0.1 s–0.1 s)  | 12.4k (10.6k–13.5k) | 152.8k (152.0k–152.8k) | 1.5k (1.5k–1.6k) | $0.081 ($0.079–$0.082) |
| `research`       | 3/3 | 28.1 s (21.3 s–34.0 s) | 7 (6–14)   | 6 (5–13)   | 9.2 s (4.6 s–16.6 s) | 8.3k (6.8k–12.7k)   | 111.2k (94.7k–190.2k)  | 0.9k (0.8k–1.5k) | $0.055 ($0.054–$0.089) |

### Fable 5.1, medium effort, `batch` mode

| Scenario         | OK  | Wall time              | Turns   | Tool calls | Server time         | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | ------- | ---------- | ------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 13.6 s (11.1 s–14.5 s) | 5 (4–5) | 4 (3–4)    | 0.9 s (0.9 s–1.1 s) | 13.2k (13.1k–13.2k) | 101.7k (79.4k–101.7k)  | 0.7k (0.6k–0.7k) | $0.249 ($0.247–$0.502) |
| `payment-retry`  | 3/3 | 21.4 s (17.2 s–29.4 s) | 6 (6–7) | 5 (5–6)    | 3.7 s (2.9 s–3.8 s) | 12.5k (12.4k–15.5k) | 99.9k (99.7k–142.3k)   | 0.8k (0.8k–1.1k) | $0.243 ($0.241–$0.278) |
| `settings-login` | 3/3 | 46.0 s (16.0 s–52.7 s) | 8 (6–9) | 7 (5–8)    | 0.1 s (0.1 s–0.7 s) | 20.1k (19.5k–22.1k) | 177.1k (126.0k–199.9k) | 1.4k (1.0k–1.4k) | $0.364 ($0.317–$0.370) |
| `research`       | 3/3 | 11.7 s (11.7 s–22.0 s) | 4       | 3          | 1.7 s (1.7 s–1.8 s) | 11.0k (11.0k–11.0k) | 79.8k (79.8k–79.8k)    | 0.6k (0.6k–0.7k) | $0.234 ($0.233–$0.236) |

### Opus 5.5, medium effort, `batch` mode

| Scenario         | OK  | Wall time              | Turns    | Tool calls | Server time         | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | -------- | ---------- | ------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 12.8 s (12.7 s–19.3 s) | 6 (5–6)  | 5 (4–5)    | 0.9 s (0.9 s–1.1 s) | 13.2k (12.9k–13.3k) | 92.8k (92.1k–92.8k)    | 0.7k (0.7k–0.7k) | $0.093 ($0.089–$0.200) |
| `payment-retry`  | 3/3 | 21.6 s (16.6 s–22.7 s) | 8 (8–10) | 7 (7–9)    | 3.0 s (2.8 s–3.1 s) | 20.2k (14.9k–28.7k) | 113.4k (112.6k–132.0k) | 1.1k (0.9k–1.4k) | $0.121 ($0.112–$0.122) |
| `settings-login` | 3/3 | 17.0 s (15.2 s–19.8 s) | 8 (7–8)  | 7 (6–7)    | 1.1 s (1.1 s–1.3 s) | 17.6k (17.4k–19.0k) | 133.5k (113.5k–136.2k) | 1.0k (1.0k–1.0k) | $0.119 ($0.112–$0.120) |
| `research`       | 3/3 | 11.4 s (11.3 s–11.5 s) | 4        | 3          | 1.7 s (1.7 s–1.7 s) | 10.7k (10.7k–10.7k) | 72.0k (72.0k–72.1k)    | 0.5k (0.5k–0.5k) | $0.081 ($0.081–$0.081) |

### Sonnet 5.5, medium effort, `batch` mode

| Scenario         | OK  | Wall time              | Turns     | Tool calls | Server time          | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | --------- | ---------- | -------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 9.7 s (9.6 s–10.1 s)   | 5 (5–6)   | 4 (4–5)    | 0.1 s (0.1 s–0.1 s)  | 15.5k (12.7k–15.5k) | 93.4k (92.6k–93.4k)    | 0.7k (0.7k–0.8k) | $0.057 ($0.055–$0.109) |
| `payment-retry`  | 3/3 | 27.0 s (20.8 s–31.4 s) | 12 (7–13) | 11 (6–12)  | 7.1 s (1.5 s–20.1 s) | 8.2k (7.9k–8.2k)    | 129.1k (127.8k–184.5k) | 1.3k (0.8k–1.4k) | $0.068 ($0.058–$0.079) |
| `settings-login` | 3/3 | 12.7 s (12.3 s–17.7 s) | 7 (7–12)  | 6 (6–11)   | 0.1 s (0.1 s–0.2 s)  | 20.1k (17.3k–25.8k) | 139.6k (136.0k–157.2k) | 1.1k (1.0k–1.3k) | $0.082 ($0.075–$0.083) |
| `research`       | 3/3 | 9.0 s (8.7 s–11.3 s)   | 4         | 3          | 1.7 s (1.7 s–1.7 s)  | 10.7k (10.7k–10.7k) | 72.0k (72.0k–72.1k)    | 0.5k (0.5k–0.6k) | $0.047 ($0.047–$0.047) |

### Haiku 4.5, medium effort, `batch` mode

| Scenario         | OK  | Wall time              | Turns      | Tool calls | Server time           | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | ---------- | ---------- | --------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 32.8 s (28.1 s–37.3 s) | 7 (7–8)    | 6 (6–7)    | 12.6 s (4.2 s–14.3 s) | 22.8k (16.2k–23.4k) | 151.0k (149.0k–170.5k) | 2.1k (1.7k–2.4k) | $0.058 ($0.056–$0.074) |
| `payment-retry`  | 3/3 | 27.5 s (21.3 s–38.5 s) | 7 (6–11)   | 6 (5–10)   | 10.2 s (6.2 s–14.2 s) | 8.4k (7.8k–10.1k)   | 151.7k (124.4k–239.5k) | 1.3k (1.2k–1.9k) | $0.051 ($0.044–$0.066) |
| `settings-login` | 3/3 | 34.3 s (31.1 s–36.8 s) | 9 (8–9)    | 8 (7–8)    | 6.1 s (3.3 s–10.3 s)  | 19.8k (19.4k–26.2k) | 191.1k (170.1k–209.9k) | 1.9k (1.9k–2.2k) | $0.055 ($0.053–$0.070) |
| `research`       | 2/3 | 58.2 s (48.5 s–68.0 s) | 31 (18–31) | 30 (17–30) | 8.1 s (7.9 s–9.8 s)   | 23.5k (8.6k–27.0k)  | 735.1k (444.0k–848.3k) | 4.5k (3.0k–4.6k) | $0.131 ($0.100–$0.156) |

### GPT-6-Astra, medium effort, `batch` mode

| Scenario         | OK  | Wall time              | Turns      | Tool calls | Server time           | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | ---------- | ---------- | --------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 34.5 s (23.9 s–42.2 s) | 5          | 4          | 0.1 s (0.1 s–0.1 s)   | 16.8k (12.5k–17.4k) | 131.5k (125.3k–132.3k) | 0.5k (0.4k–0.5k) | $0.362 ($0.351–$0.492) |
| `payment-retry`  | 3/3 | 47.4 s (36.5 s–66.3 s) | 12 (12–13) | 11 (11–12) | 2.6 s (2.6 s–2.6 s)   | 12.7k (12.7k–12.8k) | 193.4k (168.4k–195.0k) | 0.7k (0.7k–0.7k) | $0.495 ($0.454–$0.591) |
| `settings-login` | 3/3 | 62.2 s (50.7 s–74.4 s) | 7 (7–9)    | 6 (6–8)    | 10.6 s (0.1 s–10.6 s) | 20.6k (14.4k–22.0k) | 208.5k (180.7k–264.1k) | 0.7k (0.6k–0.9k) | $0.514 ($0.478–$0.584) |
| `research`       | 3/3 | 32.3 s (30.6 s–35.9 s) | 5          | 4          | 1.7 s (1.7 s–1.7 s)   | 10.7k (10.5k–11.0k) | 121.2k (121.1k–121.4k) | 0.4k (0.4k–0.4k) | $0.361 ($0.358–$0.539) |

### GPT-6.1 Sol, medium effort, `batch` mode

| Scenario         | OK  | Wall time              | Turns    | Tool calls | Server time          | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ---------------------- | -------- | ---------- | -------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 31.9 s (30.6 s–33.8 s) | 5        | 4          | 0.1 s (0.1 s–0.1 s)  | 16.8k (16.8k–17.3k) | 131.9k (130.8k–132.5k) | 0.5k (0.4k–0.5k) | $0.076 ($0.059–$0.077) |
| `payment-retry`  | 3/3 | 47.4 s (45.3 s–47.4 s) | 8 (7–14) | 7 (6–13)   | 2.5 s (2.5 s–2.6 s)  | 17.4k (13.1k–17.5k) | 180.2k (177.5k–203.6k) | 0.7k (0.6k–0.7k) | $0.069 ($0.065–$0.081) |
| `settings-login` | 3/3 | 41.2 s (40.8 s–54.6 s) | 7 (7–8)  | 6 (6–7)    | 0.2 s (0.1 s–10.2 s) | 24.1k (22.1k–26.8k) | 194.1k (185.5k–226.2k) | 0.7k (0.6k–0.7k) | $0.093 ($0.066–$0.096) |
| `research`       | 3/3 | 28.8 s (28.6 s–31.5 s) | 5        | 4          | 1.7 s (1.7 s–1.8 s)  | 11.5k (11.5k–11.5k) | 124.4k (124.1k–127.0k) | 0.4k (0.4k–0.4k) | $0.071 ($0.071–$0.074) |

### GPT-6-Luna, medium effort, `batch` mode

| Scenario         | OK  | Wall time               | Turns      | Tool calls | Server time          | Response chars      | Input tokens           | Output tokens    | Cost                   |
| ---------------- | --- | ----------------------- | ---------- | ---------- | -------------------- | ------------------- | ---------------------- | ---------------- | ---------------------- |
| `signup`         | 3/3 | 30.8 s (27.3 s–31.5 s)  | 8 (7–8)    | 7 (6–7)    | 2.1 s (1.2 s–2.4 s)  | 16.0k (14.9k–16.2k) | 222.6k (201.3k–222.7k) | 0.7k (0.7k–0.8k) | $0.005 ($0.004–$0.006) |
| `payment-retry`  | 3/3 | 36.0 s (32.0 s–111.6 s) | 11 (10–12) | 10 (9–11)  | 2.1 s (2.1 s–63.5 s) | 14.6k (12.0k–16.2k) | 312.2k (228.4k–352.7k) | 0.9k (0.7k–1.2k) | $0.007 ($0.006–$0.008) |
| `settings-login` | 3/3 | 43.3 s (34.0 s–46.3 s)  | 11 (11–12) | 10 (10–11) | 1.0 s (0.9 s–1.4 s)  | 12.3k (10.7k–12.7k) | 298.1k (266.7k–298.7k) | 1.1k (0.9k–1.3k) | $0.007 ($0.006–$0.007) |
| `research`       | 3/3 | 22.9 s (21.5 s–23.6 s)  | 6 (6–7)    | 5 (5–6)    | 1.7 s (1.7 s–1.8 s)  | 12.0k (12.0k–12.9k) | 159.4k (137.1k–160.5k) | 0.5k (0.5k–0.6k) | $0.005 ($0.004–$0.005) |

## Method

`bench/run.mjs` runs every scenario through headless Claude Code, or through the Codex CLI for `gpt-*` models, with a fresh MCP server per run.

- **Browser.** A throwaway headless Chrome with its own temporary profile, on port 9333, so benchmark runs never touch a real profile.
- **Pages.** `bench/fixture-server.mjs` serves the fixture pages from `bench/fixtures/` on loopback, with no network access. It keeps per-run state (what was submitted, how many attempts were made) so a run can be judged by what actually happened on the page.
- **Agent.** `claude -p` with `--model` and `--effort`, isolated from the machine it runs on: `--setting-sources ""` (no user or project `CLAUDE.md` or settings), `--strict-mcp-config` with only this server, `--tools ""` (no built-in tools such as Bash or Read), and `--allowedTools mcp__browser`. The runner opens the tab and gives the agent its URL and target id.
- **GPT models.** `codex exec --json` with `--ignore-user-config`, `--ephemeral`, a read-only sandbox, only this server (its tools approved in advance), and Codex's built-in browser, shell, web, app, and plugin tools turned off. Codex calls MCP tools through its code-mode `exec` tool, which stays on. Codex also loads the user's global `~/.codex/AGENTS.md` whatever the flags, so that file was moved aside during the GPT runs, matching the Claude runs, which load no user instructions.
- **Fixed overhead.** Answering "OK" with the same isolation and server takes 2.2–4.2 s through Claude Code and 4.1–8.6 s through Codex, so the CLI accounts for a few seconds of each run, not the gap between the models.
- **Modes.**
  - `single`: `run_steps` and `run_tabs` are disallowed, so every action and check is its own tool call.
  - `batch`: the full tool set, and the prompt does not mention batching.
  - `batch-hinted`: the full tool set, and the prompt asks the agent to prefer `run_steps` (the exact wording is `MODES` in `bench/run.mjs`).
- **Success.** Each scenario's `check` in `bench/scenarios.mjs` passes only if the fixture server recorded the right outcome (for example, the exact signup values, or a completed payment with no overlapping attempts) and the agent's reply contains the code the page showed at the end.
- **Repeats.** Model runs vary by several seconds between runs, so each scenario and mode runs several times. The tables show the median, with the range in parentheses when runs differ. Turns and server time vary less than wall time and are the more reliable signals.

Metrics in the tables:

- **Wall time**: from starting `claude -p` or `codex exec` until it exits.
- **Turns**: model turns reported by Claude Code. Codex does not report turns, so for GPT models it is tool calls plus the final answer.
- **Tool calls**: browser tool calls made by the agent.
- **Server time**: total time the server spent inside tool calls.
- **Response chars**: total text returned by the tools, a rough measure of how much the tools add to the context.
- **Input tokens**: uncached, cache-write, and cache-read input tokens added together.
- **Cost**: the `total_cost_usd` Claude Code reports. For GPT models, an estimate from OpenAI's standard short-context list prices on 2026-09-30 (per 1M tokens: GPT-6-Astra $10.00 input, $1.00 cached input, $50.00 output; GPT-6.1 Sol $2.00, $0.10, $10.00; GPT-6-Luna $0.10, $0.01, $0.50), counting reasoning tokens as output.

### Running it

```sh
node bench/run.mjs --model claude-sonnet-5-5 --effort medium --repeats 3 --modes single
node bench/run.mjs --model claude-sonnet-5-5 --effort medium --repeats 3 --modes batch
node bench/run.mjs --model gpt-6.1-sol --effort medium --repeats 3 --modes batch
node bench/report.mjs --out docs/images bench/results/<single>.jsonl bench/results/<batch>.jsonl ...
node bench/report.mjs --out docs/images --per-model bench/results/<model>.jsonl ...
```

`--scenarios` and `--modes` take comma-separated lists, and `--transcripts <dir>` saves each run's stream-json transcript there. Raw results go to `bench/results/`, which is not committed; each line records the build, model, effort, Chrome version, verdict, timings, token usage, tool calls, and the per-call server timings. `bench/report.mjs` prints the tables in this file from result files, in the order given; with `--out` it writes the per-scenario charts, and with `--per-model` the per-model charts instead. The runner needs macOS Chrome at its default path, or `--chrome <path>`, and a logged-in `claude` CLI (or `codex` CLI for GPT models).

## Scenarios

The source of truth is `bench/scenarios.mjs` (task prompts and success checks) and `bench/fixtures/` (the pages). Every prompt starts with the tab's URL and target id and asks the agent to attach to it; except in `research`, it also asks the agent not to open other tabs. In `batch-hinted` mode, the `research` prompt also suggests `run_tabs`.

| Id               | What the agent must do                                                                                                                                                                                                                                       | Passes when                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup`         | Dismiss a cookie banner that covers the form 500 ms after load, fill in the name, email, and plan select, tick the terms checkbox, submit, wait for the account to be created (800 ms), and report the confirmation code.                                    | The server recorded exactly "Ada Lovelace", `ada@example.com`, the Pro plan, and accepted terms, and the reply contains the confirmation code. |
| `payment-retry`  | Pay, see the first two attempts get declined (1.2 s each), retry without starting a new attempt while one is processing, and report the receipt number from the third attempt.                                                                               | The payment completed, no attempts overlapped, and the reply contains the receipt number.                                                      |
| `settings-login` | Open settings, get redirected to a login form, sign in, come back, turn email notifications off and the weekly digest on, set the language to Japanese, save (600 ms), and report the revision shown after saving. The "saved" toast disappears after 2.5 s. | The saved settings match, and the reply contains the latest revision number.                                                                   |
| `research`       | From a results page listing five component overviews, find each component's release codename, near the end of its article. Each article takes 1.5 s to load and is served from a second origin without CORS headers.                                         | The reply contains all five random codenames in the listed order.                                                                              |
