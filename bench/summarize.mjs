// Prints a Markdown summary of benchmark result files.
//
//   node bench/summarize.mjs bench/results/*.jsonl

import { readFile } from "node:fs/promises";

function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function range(values, format) {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) {
    return "n/a";
  }
  const low = Math.min(...present);
  const high = Math.max(...present);
  const middle = format(median(present));
  return low === high ? middle : `${middle} (${format(low)}–${format(high)})`;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const integer = (value) => `${Math.round(value)}`;
const thousands = (value) => `${(value / 1000).toFixed(1)}k`;
const dollars = (value) => `$${value.toFixed(3)}`;

const records = [];
for (const file of process.argv.slice(2)) {
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (line.trim()) {
      records.push(JSON.parse(line));
    }
  }
}

const groups = new Map();
for (const record of records) {
  // A trailing * marks a run from a working tree with uncommitted src changes.
  const build = `${record.commit}${record.dirty ? "*" : ""}`;
  const key = [
    build,
    record.model,
    record.effort,
    record.scenario,
    record.mode,
  ].join("|");
  if (!groups.has(key)) {
    groups.set(key, []);
  }
  groups.get(key).push(record);
}

console.log(
  "| Build | Model | Effort | Scenario | Mode | OK | Wall time | Turns | Tool calls | Server time | Response chars | Input tokens | Output tokens | Cost |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [key, runs] of groups) {
  const [build, model, effort, scenario, mode] = key.split("|");
  const pick = (read) => runs.map(read);
  const calls = (run) =>
    Object.values(run.toolCalls).reduce((total, count) => total + count, 0);
  const input = (run) =>
    run.tokens.input + run.tokens.cacheCreation + run.tokens.cacheRead;
  console.log(
    `| ${build} | ${model} | ${effort} | ${scenario} | ${mode} | ${runs.filter((run) => run.ok).length}/${runs.length} | ${range(
      pick((run) => run.wallMs),
      seconds,
    )} | ${range(
      pick((run) => run.numTurns),
      integer,
    )} | ${range(pick(calls), integer)} | ${range(
      pick((run) => run.server.ms),
      seconds,
    )} | ${range(
      pick((run) => run.server.responseChars),
      thousands,
    )} | ${range(pick(input), thousands)} | ${range(
      pick((run) => run.tokens.output),
      thousands,
    )} | ${range(
      pick((run) => run.costUsd),
      dollars,
    )} |`,
  );
}
