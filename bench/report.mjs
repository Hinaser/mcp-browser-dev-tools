// Turns benchmark result files into the tables and charts in PERFORMANCE.md.
//
//   node bench/report.mjs --out docs/images bench/results/*.jsonl
//   node bench/report.mjs --out docs/images --per-model bench/results/*.jsonl
//
// Prints one Markdown table per model, effort, and mode, with the median and
// range of each metric per scenario, and writes one SVG bar chart per metric
// (wall time, turns, cost) to --out, with one bar per model and mode in each
// scenario. With --per-model, each chart instead has one bar per model and
// mode: the average over the scenarios of that scenario's median, for
// comparing models. The charts follow the colors of docs/images and switch
// with the reader's color scheme.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: options, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "per-model": { type: "boolean", default: false },
  },
});

// A run records null for a metric it could not measure; those are left out.
const present = (values) => values.filter((value) => value !== null);

function median(values) {
  const sorted = present(values).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function range(values, format) {
  const known = present(values);
  if (known.length === 0) {
    return "n/a";
  }
  const low = Math.min(...known);
  const high = Math.max(...known);
  const middle = format(median(known));
  return low === high ? middle : `${middle} (${format(low)}–${format(high)})`;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const integer = (value) => `${Math.round(value)}`;
const thousands = (value) => `${(value / 1000).toFixed(1)}k`;
const dollars = (value) => `$${value.toFixed(3)}`;

const MODEL_NAMES = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "gpt-6-astra": "GPT-6-Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-luna": "GPT-6-Luna",
};

const modelName = (model) =>
  MODEL_NAMES[model] ?? model.replace(/^claude-/, "");

const METRICS = [
  {
    key: "wallMs",
    label: "Wall time",
    unit: "seconds",
    read: (run) => run.wallMs,
    format: seconds,
    chart: {
      file: "bench-wall-time.svg",
      scale: 1 / 1000,
      label: (v) => v.toFixed(1),
    },
  },
  {
    key: "numTurns",
    label: "Turns",
    read: (run) => run.numTurns,
    format: integer,
    chart: { file: "bench-turns.svg", scale: 1, label: (v) => `${v}` },
  },
  {
    key: "calls",
    label: "Tool calls",
    read: (run) =>
      Object.values(run.toolCalls).reduce((total, count) => total + count, 0),
    format: integer,
  },
  {
    key: "serverMs",
    label: "Server time",
    read: (run) => run.server.ms,
    format: seconds,
  },
  {
    key: "responseChars",
    label: "Response chars",
    read: (run) => run.server.responseChars,
    format: thousands,
  },
  {
    key: "input",
    label: "Input tokens",
    read: (run) =>
      run.tokens.input + run.tokens.cacheCreation + run.tokens.cacheRead,
    format: thousands,
  },
  {
    key: "output",
    label: "Output tokens",
    read: (run) => run.tokens.output,
    format: thousands,
  },
  {
    key: "costUsd",
    label: "Cost",
    unit: "US cents",
    read: (run) => run.costUsd,
    format: dollars,
    chart: { file: "bench-cost.svg", scale: 100, label: (v) => v.toFixed(1) },
  },
];

const records = [];
for (const file of files) {
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (line.trim()) {
      records.push(JSON.parse(line));
    }
  }
}

// A series is one model, effort, and mode; a group is one series' runs of
// one scenario. Both keep the order in which the files first mention them.
const series = new Map();
const scenarios = [];
for (const record of records) {
  const key = `${modelName(record.model)}|${record.effort}|${record.mode}`;
  if (!series.has(key)) {
    series.set(key, {
      key,
      label: `${modelName(record.model)} ${record.mode}`,
      groups: new Map(),
    });
  }
  const entry = series.get(key);
  if (!entry.groups.has(record.scenario)) {
    entry.groups.set(record.scenario, []);
  }
  entry.groups.get(record.scenario).push(record);
  if (!scenarios.includes(record.scenario)) {
    scenarios.push(record.scenario);
  }
}

// The legend names the effort only when the series differ in it.
const efforts = new Set([...series.keys()].map((key) => key.split("|")[1]));
if (efforts.size > 1) {
  for (const entry of series.values()) {
    const [model, effort, mode] = entry.key.split("|");
    entry.label = `${model} ${effort} ${mode}`;
  }
}

const builds = [
  ...new Set(records.map((r) => `${r.commit}${r.dirty ? "*" : ""}`)),
];
const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);
console.log(
  `${records.length} runs on ${builds.join(", ")}, ${records.filter((r) => r.ok).length} passed, $${totalCost.toFixed(2)} in total.\n`,
);

for (const entry of series.values()) {
  const [model, effort, mode] = entry.key.split("|");
  console.log(`### ${model}, ${effort} effort, \`${mode}\` mode\n`);
  console.log(`| Scenario | OK | ${METRICS.map((m) => m.label).join(" | ")} |`);
  console.log(`| --- | --- | ${METRICS.map(() => "---").join(" | ")} |`);
  for (const [scenario, runs] of entry.groups) {
    const cells = METRICS.map((metric) =>
      range(runs.map(metric.read), metric.format),
    );
    console.log(
      `| \`${scenario}\` | ${runs.filter((r) => r.ok).length}/${runs.length} | ${cells.join(" | ")} |`,
    );
  }
  console.log();
}

const MAX_SERIES = 8;

if (options.out) {
  if (series.size > MAX_SERIES) {
    throw new Error(
      `Charts show at most ${MAX_SERIES} series (model, effort, and mode); pass fewer result files`,
    );
  }
  for (const metric of METRICS.filter((m) => m.chart)) {
    const name = options["per-model"]
      ? metric.chart.file.replace("bench-", "bench-model-")
      : metric.chart.file;
    const file = join(options.out, name);
    await writeFile(
      file,
      options["per-model"] ? perModelChart(metric) : chart(metric),
    );
    console.log(`wrote ${file}`);
  }
}

// A grouped bar chart: one group per scenario, one bar per series, with the
// median on top of each bar.
function chart(metric) {
  const list = [...series.values()];
  const values = list.map((entry) =>
    scenarios.map((scenario) => {
      const runs = entry.groups.get(scenario);
      const middle = runs ? median(runs.map(metric.read)) : null;
      return middle === null ? null : middle * metric.chart.scale;
    }),
  );
  const max = Math.max(0, ...values.flat().filter((v) => v !== null));
  const top = niceCeiling(max || 1);

  const width = 880;
  const left = 56;
  const right = 24;
  const bottom = 56;
  const headroom = 48 + 18 * Math.ceil(list.length / 3);
  const plotHeight = 240;
  const height = headroom + plotHeight + bottom;
  const plotWidth = width - left - right;
  const groupWidth = plotWidth / scenarios.length;
  const barWidth = Math.min(40, (groupWidth * 0.7) / list.length);
  const y = (v) => headroom + plotHeight - (v / top) * plotHeight;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `  <title id="title">${escape(metric.label)} per scenario</title>`,
    `  <desc id="desc">${escape(describe(metric, list, values))}</desc>`,
    style(),
    `  <rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" />`,
    `  <text class="text sans" x="${left}" y="28" font-size="16" font-weight="600">${escape(metric.label)}${metric.unit ? ` (${metric.unit})` : ""}</text>`,
  );

  // Legend, three entries per row.
  list.forEach((entry, i) => {
    const x = left + (i % 3) * 200;
    const yy = 44 + Math.floor(i / 3) * 18;
    parts.push(
      `  <rect class="s${i}" x="${x}" y="${yy}" width="12" height="12" rx="2" />`,
      `  <text class="muted sans" x="${x + 18}" y="${yy + 10}" font-size="12">${escape(entry.label)}</text>`,
    );
  });

  // Gridlines and axis labels.
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const v = (top / ticks) * t;
    parts.push(
      `  <line class="rule" x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" />`,
      `  <text class="muted sans" x="${left - 8}" y="${y(v) + 4}" font-size="11" text-anchor="end">${formatTick(v)}</text>`,
    );
  }

  scenarios.forEach((scenario, s) => {
    const groupLeft =
      left + s * groupWidth + (groupWidth - barWidth * list.length) / 2;
    list.forEach((entry, i) => {
      const v = values[i][s];
      if (v === null) {
        return;
      }
      const x = groupLeft + i * barWidth;
      const h = Math.max(1, y(0) - y(v));
      parts.push(
        `  <rect class="s${i}" x="${x + 2}" y="${y(v)}" width="${barWidth - 4}" height="${h}" rx="3" />`,
        `  <text class="text sans" x="${x + barWidth / 2}" y="${y(v) - 5}" font-size="11" text-anchor="middle">${metric.chart.label(v)}</text>`,
      );
    });
    parts.push(
      `  <text class="text mono" x="${left + s * groupWidth + groupWidth / 2}" y="${height - bottom + 22}" font-size="12" text-anchor="middle">${escape(scenario)}</text>`,
    );
  });

  parts.push("</svg>", "");
  return parts.join("\n");
}

// One bar per model and mode: the average over the scenarios of the
// scenario's median, so a model's bar is comparable across models that ran
// the same scenarios.
function perModelChart(metric) {
  const list = [...series.values()];
  const values = list.map((entry) => {
    const medians = [...entry.groups.values()]
      .map((runs) => median(runs.map(metric.read)))
      .filter((v) => v !== null)
      .map((v) => v * metric.chart.scale);
    return medians.length
      ? medians.reduce((sum, v) => sum + v, 0) / medians.length
      : 0;
  });
  const top = niceCeiling(Math.max(0, ...values) || 1);

  const width = 880;
  const left = 56;
  const right = 24;
  const bottom = 56;
  const headroom = 44;
  const plotHeight = 240;
  const height = headroom + plotHeight + bottom;
  const plotWidth = width - left - right;
  const slot = plotWidth / list.length;
  const barWidth = Math.min(64, slot * 0.6);
  const y = (v) => headroom + plotHeight - (v / top) * plotHeight;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `  <title id="title">${escape(metric.label)} per task by model</title>`,
    `  <desc id="desc">${escape(list.map((entry, i) => `${entry.label} ${metric.chart.label(values[i])}`).join(", "))}</desc>`,
    style(),
    `  <rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" />`,
    `  <text class="text sans" x="${left}" y="28" font-size="16" font-weight="600">${escape(metric.label)} per task${metric.unit ? ` (${metric.unit})` : ""}, average over the scenarios</text>`,
  ];
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const v = (top / ticks) * t;
    parts.push(
      `  <line class="rule" x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" />`,
      `  <text class="muted sans" x="${left - 8}" y="${y(v) + 4}" font-size="11" text-anchor="end">${formatTick(v)}</text>`,
    );
  }
  list.forEach((entry, i) => {
    const center = left + i * slot + slot / 2;
    const v = values[i];
    parts.push(
      `  <rect class="s${i}" x="${center - barWidth / 2}" y="${y(v)}" width="${barWidth}" height="${Math.max(1, y(0) - y(v))}" rx="3" />`,
      `  <text class="text sans" x="${center}" y="${y(v) - 5}" font-size="11" text-anchor="middle">${metric.chart.label(v)}</text>`,
      `  <text class="text sans" x="${center}" y="${height - bottom + 22}" font-size="12" text-anchor="middle">${escape(entry.label)}</text>`,
    );
  });
  parts.push("</svg>", "");
  return parts.join("\n");
}

function describe(metric, list, values) {
  return scenarios
    .map((scenario, s) => {
      const items = list
        .map((entry, i) =>
          values[i][s] === null
            ? null
            : `${entry.label} ${metric.chart.label(values[i][s])}`,
        )
        .filter(Boolean);
      return `${scenario}: ${items.join(", ")}`;
    })
    .join(". ");
}

function niceCeiling(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 4, 5, 10]) {
    if (value <= step * magnitude) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

function formatTick(v) {
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

function escape(text) {
  return String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

function style() {
  return `  <style>
    .bg { fill: #f6f8fa; stroke: #d1d9e0; }
    .rule { stroke: #d1d9e0; }
    .text { fill: #1f2328; }
    .muted { fill: #59636e; }
    .s0 { fill: #0969da; }
    .s1 { fill: #bf8700; }
    .s2 { fill: #1a7f37; }
    .s3 { fill: #8250df; }
    .s4 { fill: #cf222e; }
    .s5 { fill: #1b7c83; }
    .s6 { fill: #bc4c00; }
    .s7 { fill: #bf3989; }
    .sans { font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; stroke: #3d444d; }
      .rule { stroke: #3d444d; }
      .text { fill: #f0f6fc; }
      .muted { fill: #9198a1; }
      .s0 { fill: #4493f8; }
      .s1 { fill: #d29922; }
      .s2 { fill: #3fb950; }
      .s3 { fill: #ab7df8; }
      .s4 { fill: #f85149; }
      .s5 { fill: #39c5cf; }
      .s6 { fill: #f0883e; }
      .s7 { fill: #db61a2; }
    }
  </style>`;
}
