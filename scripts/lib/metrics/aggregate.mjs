// scripts/lib/metrics/aggregate.mjs
//
// Daily JSONL -> weekly rollup aggregator. Reads
// .claude/state/metrics/<yyyy>-<mm>-<dd>.jsonl files inside the ISO week
// window and produces a single object conforming to
// schemas/metrics-weekly.schema.json.
//
// Determinism: the rollup key set is stable (skills sorted lex); numeric
// fields are rounded so two aggregator runs over the same JSONL produce
// byte-identical JSON. red_flags rendering is sorted by skill name then
// kind so diff noise stays low across re-runs.
//
// Threshold logic mirrors the issue body: cache_hit_rate < min OR
// avg_tokens > ceiling raises a red flag. Both thresholds are
// project-configurable via observability.alert_thresholds in
// ops.config.json; the aggregator accepts them as plain options so it
// stays pure (no config-loading inside this module).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute the start (Mon 00:00:00 UTC) and end (next Mon 00:00:00 UTC)
 * of the ISO week containing `date`. `start` and `end` are returned as
 * Date objects (UTC midnight); `isoWeek` is the ISO 8601 week
 * designation (e.g. "2026-W17"). Callers that need a string boundary
 * should call `.toISOString()` on the Date themselves.
 *
 * @param {Date} date
 * @returns {{start: Date, end: Date, isoWeek: string}}
 */
export function isoWeekWindow(date) {
  // Convert any Date to UTC midnight; ISO weeks are defined in UTC for
  // our purposes (cross-team aggregation must not skew by host TZ).
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weekday: Mon=1, Sun=7. JS getUTCDay: Sun=0, Mon=1.
  const dow = d.getUTCDay() || 7;
  // Move back to the Monday of this week.
  const monday = new Date(d.getTime() - (dow - 1) * MS_PER_DAY);
  const nextMonday = new Date(monday.getTime() + 7 * MS_PER_DAY);
  return { start: monday, end: nextMonday, isoWeek: isoWeekDesignation(monday) };
}

/**
 * Return the ISO 8601 week designation (e.g. 2026-W17) for a Monday
 * (the start of an ISO week).
 *
 * @param {Date} monday
 * @returns {string}
 */
export function isoWeekDesignation(monday) {
  // ISO 8601 week-numbering year may differ from the Gregorian year for
  // the first / last days of the year. Standard algorithm: Thursday of
  // the week determines the year.
  const d = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()));
  const thursday = new Date(d.getTime() + 3 * MS_PER_DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * MS_PER_DAY);
  const weekIndex = Math.round((d.getTime() - week1Monday.getTime()) / (7 * MS_PER_DAY)) + 1;
  return `${year}-W${String(weekIndex).padStart(2, "0")}`;
}

/**
 * Iterate the JSONL files inside the metrics directory whose YYYY-MM-DD
 * filename falls within [start, end). Returns a flat array of record
 * objects. Malformed lines are skipped with no throw — the recorder is
 * the contract gate; the aggregator stays resilient.
 *
 * Schema enforcement: schemas/metrics-record.schema.json sets
 * additionalProperties:false at every layer, but THIS function does
 * not run ajv validation against parsed lines. That is deliberate:
 * a bad line (extra key, fractional token, negative cost) is degraded
 * gracefully by the downstream `intNum` / `num` clamps and the
 * `isPlainRecord` shape check, which keeps a single corrupted line
 * from blowing up the whole weekly rollup. Third-party consumers that
 * want strict additionalProperties enforcement should run their own
 * ajv pass on the raw JSONL; the schema file is the contract for them.
 *
 * @param {string} metricsDir
 * @param {Date} start
 * @param {Date} end
 */
export function readRecordsInWindow(metricsDir, start, end) {
  // Single TOCTOU-safe stat. existsSync was the previous gate but it
  // does not guarantee the path is a DIRECTORY: a metricsDir that
  // points at a regular file (or a symlink to one, or a dead symlink)
  // would slip past existsSync and crash readdirSync with ENOTDIR /
  // ENOENT, taking the weekly report CLI down. statSync inside a
  // try/catch handles every failure mode (missing, not-a-dir,
  // permission denied) by returning the same empty-window result.
  let st;
  try {
    st = statSync(metricsDir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const startKey = ymdKey(start);
  const endKey = ymdKey(end);
  // Even though the statSync above proved the directory existed at
  // T0, readdirSync can still throw at T1 if the dir is removed,
  // permissions change, or the volume goes offline between the two
  // calls. The aggregator's contract is "stay resilient on FS
  // issues"; treat any failure here as an empty window.
  let entries;
  try {
    entries = readdirSync(metricsDir);
  } catch {
    return [];
  }
  const files = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => {
      const k = f.slice(0, 10);
      // [start, end): inclusive lower, exclusive upper.
      return k >= startKey && k < endKey;
    })
    .sort();
  const records = [];
  for (const f of files) {
    // Same TOCTOU window for the per-file read: the file might have
    // been rotated / removed between readdirSync above and this
    // readFileSync. Skip the file on any read error so the rollup
    // stays computable instead of crashing the whole CLI.
    let lines;
    try {
      lines = readFileSync(join(metricsDir, f), "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      records.push(parsed);
    }
  }
  return records;
}

/**
 * Aggregate records into the weekly rollup shape.
 *
 * @param {object[]} records  output of readRecordsInWindow
 * @param {object} opts
 * @param {string} opts.isoWeek
 * @param {{start: Date, end: Date}} [opts.window]
 * @param {{cache_hit_rate_min?: number, per_skill_token_ceiling?: number}} [opts.thresholds]
 * @param {Map<string, number>} [opts.previousAvgCostBySkill] previous-week avg_cost by skill, used for delta_vs_prev
 * @returns {object} conforming to schemas/metrics-weekly.schema.json
 */
export function aggregate(records, opts) {
  if (!opts || typeof opts.isoWeek !== "string") {
    throw new Error("metrics.aggregate: opts.isoWeek is required");
  }
  const thresholds = opts.thresholds ?? {};
  const previousAvgCostBySkill = opts.previousAvgCostBySkill ?? new Map();

  // Per-skill accumulators. Sub-invocations whose parent chain RESOLVES
  // inside the aggregation window are folded into the root parent's
  // totals (parent_trace_id != null contributes cost/tokens to the
  // parent's row, not its own). Sub-invocations whose parent record is
  // NOT present in this batch ("orphan subs") are dropped from the
  // rollup entirely — they neither surface as their own per_skill row
  // nor fold into a phantom parent. Promoting orphans to top-level
  // rows would make per_skill invocation counts unstable at week
  // boundaries (a sub run on Sunday whose parent ran on Monday would
  // flip between "folded" and "phantom" depending on the aggregation
  // window). When cross-week accuracy matters, widen the window.
  const recordsByTraceId = new Map();
  for (const r of records) {
    if (r && typeof r.trace_id === "string") {
      recordsByTraceId.set(r.trace_id, r);
    }
  }

  const skillStats = new Map(); // skill -> accumulator
  const totals = {
    invocations: 0,
    cost_usd: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };

  for (const r of records) {
    if (!isPlainRecord(r)) continue;
    const isSub = r.parent_trace_id != null;
    // Walk the parent chain to the root skill, not just the immediate
    // parent. A sub-invocation can itself fan out to nested subagents;
    // each level carries its own parent_trace_id. Resolve to the
    // top-most ancestor's skill so the per-skill row counts every
    // descendant against the work that originated it. Handles cycles
    // defensively via resolveRootSkill().
    const rootSkill = isSub ? resolveRootSkill(r, recordsByTraceId) : r.skill;
    // Sub-invocations whose parent record is NOT present in this batch
    // ("orphan subs") are dropped from the rollup entirely. Per the
    // contract in the issue body and the PR description, sub-invocations
    // never surface as their own per_skill row — they fold into the
    // parent's row when the parent is in-window, and otherwise are
    // omitted. Promoting an orphan to a phantom top-level row would
    // make `per_skill` invocation counts unstable at week boundaries
    // (a sub run on Sunday whose parent ran on Monday flips between
    // "folded" and "phantom" depending on the aggregation window).
    // The cost/tokens are lost from the rollup; widening the window is
    // the supported fix when cross-week accuracy matters.
    if (isSub && rootSkill == null) continue;
    const skill = rootSkill;
    if (!skill) continue; // truly malformed; nothing to do
    const countsAsInvocation = !isSub;

    const acc = skillStats.get(skill) ?? newSkillAcc();
    if (countsAsInvocation) acc.invocations += 1;
    acc.cost_usd += num(r.cost_usd);
    acc.tokens_input += intNum(r.tokens?.input);
    acc.tokens_output += intNum(r.tokens?.output);
    acc.tokens_cache_read += intNum(r.tokens?.cache_read);
    acc.tokens_cache_write += intNum(r.tokens?.cache_write);
    skillStats.set(skill, acc);

    // Cost AND tokens include in-window sub-invocations (folded into
    // the root parent's totals): a top-level dev-loop run that fans
    // out to three Explorer subagents surfaces the full bill in
    // totals.cost_usd, not just the parent's share. Invocations count
    // distinct user-visible work units (top-level only); orphan subs
    // were already filtered out above so they never reach this branch.
    if (countsAsInvocation) totals.invocations += 1;
    totals.cost_usd += num(r.cost_usd);
    totals.tokens.input += intNum(r.tokens?.input);
    totals.tokens.output += intNum(r.tokens?.output);
    totals.tokens.cache_read += intNum(r.tokens?.cache_read);
    totals.tokens.cache_write += intNum(r.tokens?.cache_write);
  }

  const perSkill = [];
  const redFlags = [];
  // Deterministic order: lex by skill name.
  const skillNames = [...skillStats.keys()].sort();
  for (const skill of skillNames) {
    const acc = skillStats.get(skill);
    const totalTokens = acc.tokens_input + acc.tokens_output + acc.tokens_cache_read + acc.tokens_cache_write;
    const inv = Math.max(acc.invocations, 1); // avoid /0 for sub-only rows (which we already filter, but defensive)
    const avgTokens = Math.round(totalTokens / inv);
    const avgCost = round6(acc.cost_usd / inv);
    const cacheHit = computeCacheHitRate(acc.tokens_input, acc.tokens_cache_read);
    const prev = previousAvgCostBySkill.get(skill);
    // delta_vs_prev is null when the relative change is undefined:
    //   - skill missing from the prev-week map (newly seen)
    //   - prev was 0 AND avgCost is non-zero (infinite relative change)
    // When BOTH weeks were 0, return 0 (literally no change in cost).
    // Schema description on `delta_vs_prev` records the same union.
    let delta;
    if (prev == null) delta = null;
    else if (prev === 0) delta = avgCost === 0 ? 0 : null;
    else delta = round4((avgCost - prev) / prev);
    const row = {
      skill,
      invocations: acc.invocations,
      avg_tokens: avgTokens,
      cache_hit_rate: cacheHit,
      avg_cost: avgCost,
      delta_vs_prev: delta,
    };
    perSkill.push(row);

    if (typeof thresholds.cache_hit_rate_min === "number" && cacheHit < thresholds.cache_hit_rate_min) {
      redFlags.push({
        skill,
        kind: "cache_hit_rate_below_min",
        message: `cache_hit_rate ${pct(cacheHit)} < ${pct(thresholds.cache_hit_rate_min)}`,
      });
    }
    if (typeof thresholds.per_skill_token_ceiling === "number" && avgTokens > thresholds.per_skill_token_ceiling) {
      redFlags.push({
        skill,
        kind: "avg_tokens_above_ceiling",
        message: `avg_tokens ${avgTokens} > ${thresholds.per_skill_token_ceiling}`,
      });
    }
  }

  redFlags.sort((a, b) => (a.skill === b.skill ? a.kind.localeCompare(b.kind) : a.skill.localeCompare(b.skill)));

  const out = {
    iso_week: opts.isoWeek,
    totals: {
      invocations: totals.invocations,
      cost_usd: round6(totals.cost_usd),
      tokens: totals.tokens,
      cache_hit_rate: computeCacheHitRate(totals.tokens.input, totals.tokens.cache_read),
    },
    per_skill: perSkill,
    thresholds: pickThresholds(thresholds),
    red_flags: redFlags,
  };
  if (opts.window) {
    out.window = {
      start: opts.window.start.toISOString(),
      end: opts.window.end.toISOString(),
    };
  }
  return out;
}

/**
 * Render a markdown report from the aggregator's output. The shape
 * matches the worked example in the issue body: a header line, an
 * overall cache-hit summary, the per-skill table, and a red-flags
 * section.
 *
 * @param {object} weekly  output of aggregate()
 * @returns {string}
 */
export function renderMarkdown(weekly) {
  const lines = [];
  lines.push(`# Week ${weekly.iso_week}`);
  lines.push("");
  const t = weekly.totals;
  const avg = t.invocations > 0 ? round4(t.cost_usd / t.invocations) : 0;
  lines.push(`Total cost: $${t.cost_usd.toFixed(2)} across ${t.invocations} skill invocations (avg $${avg.toFixed(2)})`);
  const cacheStr = pct(t.cache_hit_rate);
  const minStr = typeof weekly.thresholds.cache_hit_rate_min === "number"
    ? ` (target >= ${pct(weekly.thresholds.cache_hit_rate_min)} ${t.cache_hit_rate >= weekly.thresholds.cache_hit_rate_min ? "OK" : "MISS"})`
    : "";
  lines.push(`Cache hit rate: ${cacheStr} overall${minStr}`);
  lines.push("");
  lines.push("Per-skill table:");
  lines.push("");
  lines.push("| skill | invocations | avg_tokens | cache_hit | avg_cost | delta_vs_prev |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of weekly.per_skill) {
    const delta = row.delta_vs_prev == null
      ? "new"
      : `${row.delta_vs_prev >= 0 ? "+" : ""}${(row.delta_vs_prev * 100).toFixed(0)} %`;
    lines.push(`| ${row.skill} | ${row.invocations} | ${row.avg_tokens} | ${pct(row.cache_hit_rate)} | $${row.avg_cost.toFixed(2)} | ${delta} |`);
  }
  if (weekly.red_flags.length > 0) {
    lines.push("");
    lines.push("Red flags:");
    for (const flag of weekly.red_flags) {
      lines.push(`- ${flag.skill}: ${flag.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- internals ----------

/**
 * Walk the parent_trace_id chain back to the top-level record and
 * return its skill. Returns null if the chain leaves the supplied
 * record map (parent not in this aggregation window) so the caller
 * can decide how to handle the orphan.
 *
 * Defends against cycles via a visited set; the chain length cap of
 * 16 is generous (real-world subagent depth is 1 or 2) and prevents
 * an adversarial JSONL from spinning the aggregator.
 */
function resolveRootSkill(record, recordsByTraceId) {
  let cur = record;
  const visited = new Set();
  let depth = 0;
  while (cur && cur.parent_trace_id != null && depth < 16) {
    if (visited.has(cur.trace_id)) return null; // cycle
    visited.add(cur.trace_id);
    const parent = recordsByTraceId.get(cur.parent_trace_id);
    if (!parent) return null; // parent not in window
    cur = parent;
    depth++;
  }
  // After the loop, `cur` is a root only when its parent_trace_id is
  // null. Hitting the depth cap with parent_trace_id still set means
  // the chain is corrupted (deeper than any real workflow ever
  // produces); folding that into a phantom row would over-count.
  // Return null so the caller drops the record the same way it drops
  // a parent-not-in-window orphan.
  if (cur == null || cur.parent_trace_id != null) return null;
  // Also reject roots that fail isPlainRecord. The main loop skips
  // malformed records via isPlainRecord, so the parent's own
  // invocations counter never increments — but if a sub-invocation
  // resolves to that malformed parent's skill, it would fold cost
  // and tokens into a per_skill row whose invocations stayed at 0.
  // That over-counts the rollup and produces an "invocations=0,
  // cost>0" combination the schema technically allows but no
  // downstream consumer wants to see. Drop the chain instead.
  if (!isPlainRecord(cur)) return null;
  return typeof cur.skill === "string" ? cur.skill : null;
}

function newSkillAcc() {
  return {
    invocations: 0,
    cost_usd: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  };
}

function isPlainRecord(r) {
  return r && typeof r === "object" && typeof r.skill === "string" && r.tokens && typeof r.tokens === "object";
}

function num(v) {
  // Clamp negative values to 0. The recorder validates non-negative
  // counts at write time, but a corrupted / hand-edited JSONL line
  // could land a negative, and weekly rollups have `minimum: 0` on
  // every cost / token field (schemas/metrics-weekly.schema.json).
  // Coercing here keeps the rollup schema-conformant even when the
  // input file is damaged; we'd rather under-count a row than emit
  // a JSON object the consumer's validator will reject outright.
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n;
}

function intNum(v) {
  // Token-field variant of num(): also truncates to integer. The
  // weekly rollup schema requires every tokens.* and per_skill.*.tokens.*
  // field to be an integer (minimum 0). buildRecord coerces token
  // inputs through Math.trunc(), but a hand-edited JSONL line could
  // still land a fractional value; truncating here keeps the rollup
  // schema-valid without forcing readRecordsInWindow to reject the
  // whole record. Cost stays float (num()) since cost_usd is allowed
  // to carry decimal precision.
  return Math.trunc(num(v));
}

function computeCacheHitRate(input, cacheRead) {
  const denom = num(input) + num(cacheRead);
  if (denom === 0) return 0;
  return round4(num(cacheRead) / denom);
}

function round4(n) {
  return Number(n.toFixed(4));
}

function round6(n) {
  return Number(n.toFixed(6));
}

function pct(n) {
  return `${(n * 100).toFixed(0)} %`;
}

function ymdKey(d) {
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function pickThresholds(thresholds) {
  const out = {};
  if (typeof thresholds.cache_hit_rate_min === "number") out.cache_hit_rate_min = thresholds.cache_hit_rate_min;
  if (typeof thresholds.per_skill_token_ceiling === "number") out.per_skill_token_ceiling = thresholds.per_skill_token_ceiling;
  return out;
}

// Exported for tests; kept small.
export const _internals = {
  ymdKey,
  computeCacheHitRate,
  round4,
  round6,
  pct,
  resolve,
};
