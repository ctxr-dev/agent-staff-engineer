#!/usr/bin/env node
// scripts/report_metrics.mjs
//
// CLI entry: render a weekly metrics rollup from the daily JSONL files
// in .claude/state/metrics/. Usage:
//
//   node scripts/report_metrics.mjs --weekly [--week YYYY-Www] [--metrics-dir <dir>]
//                                   [--out-dir <dir>] [--cache-min <0..1>]
//                                   [--token-ceiling <int>] [--prev-week-json <path>]
//
// Without --week the current week (UTC) is used. Without --metrics-dir
// the script defaults to <cwd>/.claude/state/metrics. Output:
//   1. JSON rollup written to <out-dir>/<isoWeek>.json
//   2. Markdown report written to <out-dir>/<isoWeek>.md
//   3. The markdown report is also echoed to stdout
//
// The JSON rollup is the durable artefact (other tools consume it); the
// markdown is the human-readable view.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgv } from "./lib/argv.mjs";
import {
  isoWeekWindow,
  readRecordsInWindow,
  aggregate,
  renderMarkdown,
} from "./lib/metrics/aggregate.mjs";

function main() {
  const { flags } = parseArgv(process.argv.slice(2), {
    booleans: new Set(["weekly", "help"]),
  });
  if (flags.help) {
    printHelp();
    return;
  }
  if (!flags.weekly) {
    process.stderr.write("error: pass --weekly (other rollups not yet implemented)\n");
    process.exit(2);
  }

  const cwd = process.cwd();
  const metricsDir = flags["metrics-dir"]
    ? resolve(cwd, String(flags["metrics-dir"]))
    : resolve(cwd, ".claude", "state", "metrics");
  const outDir = flags["out-dir"]
    ? resolve(cwd, String(flags["out-dir"]))
    : resolve(cwd, ".development", "shared", "reports", "metrics");

  const referenceDate = flags.week
    ? mondayFromIsoWeek(String(flags.week))
    : new Date();
  const window = isoWeekWindow(referenceDate);
  const records = readRecordsInWindow(metricsDir, window.start, window.end);

  const previousAvgCostBySkill = flags["prev-week-json"]
    ? loadPreviousAvgCost(String(flags["prev-week-json"]))
    : new Map();

  const thresholds = {};
  if (flags["cache-min"] != null) {
    const n = Number(flags["cache-min"]);
    if (Number.isFinite(n) && n >= 0 && n <= 1) thresholds.cache_hit_rate_min = n;
  }
  if (flags["token-ceiling"] != null) {
    const n = Number(flags["token-ceiling"]);
    if (Number.isFinite(n) && n >= 0) thresholds.per_skill_token_ceiling = Math.trunc(n);
  }

  const rollup = aggregate(records, {
    isoWeek: window.isoWeek,
    window,
    thresholds,
    previousAvgCostBySkill,
  });
  const md = renderMarkdown(rollup);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${window.isoWeek}.json`);
  const mdPath = join(outDir, `${window.isoWeek}.md`);
  writeFileSync(jsonPath, JSON.stringify(rollup, null, 2) + "\n");
  writeFileSync(mdPath, md);

  process.stdout.write(md);
  process.stdout.write(`\n(rollup written to ${jsonPath})\n`);
}

function printHelp() {
  process.stdout.write(
    "Usage: node scripts/report_metrics.mjs --weekly [--week YYYY-Www]\n" +
      "                                       [--metrics-dir <dir>] [--out-dir <dir>]\n" +
      "                                       [--cache-min <0..1>] [--token-ceiling <int>]\n" +
      "                                       [--prev-week-json <path>]\n",
  );
}

function mondayFromIsoWeek(isoWeek) {
  // Accept "YYYY-Www" and return the Monday of that ISO week as a Date.
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) {
    process.stderr.write(`error: --week must be YYYY-Www (got ${JSON.stringify(isoWeek)})\n`);
    process.exit(2);
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO 8601: week 1 is the week containing Jan 4. Monday of week 1 is
  // Jan 4 minus its weekday-1 days. Then add (week-1) * 7 days.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * 86400000);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
}

function loadPreviousAvgCost(path) {
  // Load a previous-week rollup JSON and return a Map<skill, avg_cost>.
  // Used to compute delta_vs_prev. Missing or malformed input ->
  // empty Map (no deltas), never throws.
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || !Array.isArray(parsed.per_skill)) return new Map();
    const out = new Map();
    for (const row of parsed.per_skill) {
      if (typeof row?.skill === "string" && typeof row?.avg_cost === "number") {
        out.set(row.skill, row.avg_cost);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

main();
