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

import { mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgv, boolFlag } from "./lib/argv.mjs";
import { atomicWriteText } from "./lib/fsx.mjs";
import { preflight } from "./preflight.mjs";
import {
  isoWeekWindow,
  readRecordsInWindow,
  aggregate,
  renderMarkdown,
} from "./lib/metrics/aggregate.mjs";

async function main() {
  const { flags } = parseArgv(process.argv.slice(2), {
    booleans: new Set(["weekly", "help"]),
  });
  // Resolve --help / --weekly through boolFlag so a `--help=false` or
  // `--weekly=false` (parseArgv's eq branch yields the string "false",
  // which is truthy) is interpreted as an explicit "no" rather than
  // an enabled flag.
  if (boolFlag(flags, "help")) {
    printHelp();
    return;
  }
  if (!boolFlag(flags, "weekly")) {
    process.stderr.write("error: pass --weekly (other rollups not yet implemented)\n");
    process.exit(2);
  }

  // Reject bare flags (`--metrics-dir` without a value) explicitly.
  // parseArgv yields boolean `true` for a bare flag; without this
  // guard the value would be coerced (`String(true)` -> "true",
  // `Number(true)` -> 1) and silently produce surprising behaviour
  // (--metrics-dir=true reading a directory called "true";
  // --token-ceiling silently setting the threshold to 1; etc.).
  // Apply the guard to every string-valued AND number-valued flag.
  for (const f of ["metrics-dir", "out-dir", "prev-week-json", "week", "cache-min", "token-ceiling"]) {
    if (f in flags && typeof flags[f] !== "string") {
      process.stderr.write(`error: --${f} requires a value (got bare flag)\n`);
      process.exit(2);
    }
    if (typeof flags[f] === "string" && flags[f].length === 0) {
      process.stderr.write(`error: --${f} value must be non-empty\n`);
      process.exit(2);
    }
  }

  const cwd = process.cwd();
  const metricsDir = flags["metrics-dir"]
    ? resolve(cwd, String(flags["metrics-dir"]))
    : resolve(cwd, ".claude", "state", "metrics");
  // Default out-dir lives under .claude/state/, which is OUTSIDE the
  // wiki-governed .development/** tree entirely (the wiki roots
  // include .development/local/ and .development/shared/, both of
  // which require the skill-llm-wiki nested-scalable layout per
  // rules/llm-wiki.md). Weekly rollups are flat per-week artefacts
  // that do not fit that layout, so writing them anywhere under
  // .development/** would either bypass wiki invariants or trip
  // them. .claude/state/ is the staging area for derivative state
  // (the daily JSONL records already live alongside, in
  // .claude/state/metrics/). A project that wants to publish a
  // curated rollup to the team wiki can copy it from here and run
  // it through the wiki skill manually.
  const outDir = flags["out-dir"]
    ? resolve(cwd, String(flags["out-dir"]))
    : resolve(cwd, ".claude", "state", "metrics-weekly");

  const referenceDate = flags.week
    ? mondayFromIsoWeek(String(flags.week))
    : new Date();
  const window = isoWeekWindow(referenceDate);
  const records = readRecordsInWindow(metricsDir, window.start, window.end);

  const previousAvgCostBySkill = flags["prev-week-json"]
    ? loadPreviousAvgCost(String(flags["prev-week-json"]))
    : new Map();

  // Threshold flags. Fail-fast on invalid values rather than silently
  // dropping the threshold: a typo like `--cache-min=7` or
  // `--token-ceiling=-1` previously meant the report ran without that
  // threshold applied, which is surprising in ops usage where the user
  // expects red flags AND would not notice the omission until they
  // skim the rendered markdown.
  const thresholds = {};
  if (flags["cache-min"] != null) {
    const raw = flags["cache-min"];
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      process.stderr.write(`error: --cache-min must be a number in [0, 1]; got ${JSON.stringify(raw)}\n`);
      process.exit(2);
    }
    thresholds.cache_hit_rate_min = n;
  }
  if (flags["token-ceiling"] != null) {
    const raw = flags["token-ceiling"];
    const n = Number(raw);
    // --token-ceiling is documented as an INTEGER count; silently
    // truncating a fractional input (e.g. 5000.9 -> 5000) hides typos
    // and makes the effective threshold non-obvious in the rendered
    // report. Reject explicitly so the user fixes the command line.
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      process.stderr.write(`error: --token-ceiling must be a non-negative integer; got ${JSON.stringify(raw)}\n`);
      process.exit(2);
    }
    thresholds.per_skill_token_ceiling = n;
  }

  const rollup = aggregate(records, {
    isoWeek: window.isoWeek,
    window,
    thresholds,
    previousAvgCostBySkill,
  });
  const md = renderMarkdown(rollup);

  // Out-dir guard: if the path exists but is not a directory (e.g.
  // user pointed `--out-dir` at a file), surface a friendly error
  // and exit 2 instead of letting atomicWriteText surface an opaque
  // EISDIR/EACCES at write time. Same shape as the metrics-dir
  // guard in aggregate.mjs::readRecordsInWindow.
  if (existsSync(outDir)) {
    let outStat;
    try {
      outStat = statSync(outDir);
    } catch (err) {
      process.stderr.write(`error: --out-dir ${JSON.stringify(outDir)} stat failed: ${err?.message ?? String(err)}\n`);
      process.exit(2);
    }
    if (!outStat.isDirectory()) {
      process.stderr.write(`error: --out-dir ${JSON.stringify(outDir)} exists but is not a directory\n`);
      process.exit(2);
    }
  } else {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      process.stderr.write(`error: --out-dir ${JSON.stringify(outDir)} could not be created: ${err?.message ?? String(err)}\n`);
      process.exit(2);
    }
  }
  const jsonPath = join(outDir, `${window.isoWeek}.json`);
  const mdPath = join(outDir, `${window.isoWeek}.md`);
  // Atomic writes (write-to-temp + rename) so a SIGINT mid-run never
  // leaves a partial JSON or markdown behind. Matches the convention
  // in scripts/install.mjs and the rest of the writer surface.
  await atomicWriteText(jsonPath, JSON.stringify(rollup, null, 2) + "\n");
  await atomicWriteText(mdPath, md);

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
  // Accept YYYY-Www with the week digits constrained to 01..53. Reject
  // W00 and W54..W99 fast — those are impossible ISO weeks. Matches the
  // pattern in schemas/metrics-weekly.schema.json.
  const m = /^(\d{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/.exec(isoWeek);
  if (!m) {
    process.stderr.write(`error: --week must be YYYY-Www with week 01..53 (got ${JSON.stringify(isoWeek)})\n`);
    process.exit(2);
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO 8601: week 1 is the week containing Jan 4. Monday of week 1 is
  // Jan 4 minus its weekday-1 days. Then add (week-1) * 7 days.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * 86400000);
  const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
  // Round-trip validation: ISO week 53 only exists for "long" years
  // (where Jan 1 is a Thursday, or a leap year where Jan 1 is a
  // Wednesday). For a year without a W53, computing
  // monday-of-W53 above silently rolls into the next ISO year's W01,
  // and a later report would target the wrong window without warning.
  // Re-derive the ISO week designation from the computed Monday and
  // bail if it differs from the user-supplied input.
  const roundTrip = isoWeekWindow(monday).isoWeek;
  if (roundTrip !== isoWeek) {
    process.stderr.write(
      `error: --week ${JSON.stringify(isoWeek)} is not a valid ISO 8601 week (re-derived as ${JSON.stringify(roundTrip)}; W53 does not exist for every ISO year)\n`,
    );
    process.exit(2);
  }
  return monday;
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

// Direct-run guard with the shared `?? ""` form so module imports don't
// trigger the CLI side-effect. preflight() runs first to surface a
// friendly error on too-old Node, matching every other bundle CLI.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await preflight();
  await main().catch((err) => {
    process.stderr.write(`error: ${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
