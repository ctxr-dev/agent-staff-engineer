// scripts/lib/metrics/record.mjs
//
// Per-skill invocation recorder. Appends ONE JSONL line per invocation
// to .claude/state/metrics/<yyyy>-<mm>-<dd>.jsonl, keyed by the start
// timestamp's UTC date. Pure record-side logic; the aggregator
// (aggregate.mjs) reads these files to produce weekly rollups.
//
// Record shape: schemas/metrics-record.schema.json. The recorder
// produces records that conform to that schema; aggregate-time
// validation is the consumer's job (record-time validation would
// add latency to every skill invocation for marginal value).
//
// Cost computation: cost_usd is derived from the four token fields and
// a model rate table. The table covers the rates documented at the
// time of writing; callers may pass `rates` explicitly to override
// (useful in tests and when a model's rate changes between releases).

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

// Per-million-token rates in USD. Source: documented Anthropic public
// pricing at the time of authoring. Override via `opts.rates` when
// invoking record(); aggregate-time computations also accept overrides.
//
// Wildcard `default` is used when the model field is absent or unknown
// so an invocation never lands with cost=0 silently.
export const DEFAULT_RATES = {
  "claude-opus-4-7":      { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
  "claude-sonnet-4-6":    { input:  3.00, output: 15.00, cache_read: 0.30, cache_write:  3.75 },
  "claude-haiku-4-5":     { input:  1.00, output:  5.00, cache_read: 0.10, cache_write:  1.25 },
  default:                { input:  3.00, output: 15.00, cache_read: 0.30, cache_write:  3.75 },
};

/**
 * Compute the USD cost for one invocation's tokens against a rate table.
 * Pure: same inputs always produce the same output. Rates are per
 * million tokens; we divide once.
 *
 * @param {{input:number, output:number, cache_read:number, cache_write:number}} tokens
 * @param {string} [model]
 * @param {typeof DEFAULT_RATES} [rates]
 * @returns {number}
 */
export function computeCostUsd(tokens, model, rates = DEFAULT_RATES) {
  const rate = (model && rates[model]) || rates.default;
  const cost =
    (tokens.input * rate.input) +
    (tokens.output * rate.output) +
    (tokens.cache_read * rate.cache_read) +
    (tokens.cache_write * rate.cache_write);
  // Round to 6 dp to keep JSONL stable. JSON.stringify on Number is
  // ECMAScript-spec-stable for finite values, but we round defensively
  // so cross-process JSON diffs stay byte-identical.
  return Number((cost / 1_000_000).toFixed(6));
}

/**
 * Generate a stable trace id. Stays independent of process.pid so
 * subagent invocations don't collide with parents on the same host.
 * @returns {string}
 */
export function newTraceId() {
  return `t-${randomBytes(8).toString("hex")}`;
}

/**
 * Build a record from the supplied invocation summary. Returns the
 * record object so callers can inspect it before writing (useful in
 * tests). The `tokens` object MUST carry all four fields; pass 0 for
 * any that don't apply.
 *
 * @param {object} input
 * @param {string} input.skill
 * @param {string} input.started_at  ISO 8601
 * @param {string} input.ended_at    ISO 8601
 * @param {{input:number, output:number, cache_read:number, cache_write:number}} input.tokens
 * @param {string} [input.trace_id]
 * @param {string} [input.parent_trace_id]
 * @param {string} [input.model]
 * @param {{count:number, total_tokens:number}} [input.subagents]
 * @param {string[]} [input.mcp_servers_used]
 * @param {"success"|"halt"|"fault"|"error"|"cancelled"} [input.exit]
 * @param {typeof DEFAULT_RATES} [input.rates]
 * @returns {object}
 */
export function buildRecord(input) {
  const required = ["skill", "started_at", "ended_at", "tokens"];
  for (const k of required) {
    if (input[k] == null) throw new Error(`metrics.buildRecord: ${k} is required`);
  }
  const tokens = normaliseTokens(input.tokens);
  const record = {
    trace_id: input.trace_id ?? newTraceId(),
    parent_trace_id: input.parent_trace_id ?? null,
    skill: input.skill,
    started_at: input.started_at,
    ended_at: input.ended_at,
    tokens,
    cost_usd: computeCostUsd(tokens, input.model, input.rates),
    exit: input.exit ?? "success",
  };
  if (input.model) record.model = input.model;
  if (input.subagents) {
    record.subagents = {
      count: int(input.subagents.count),
      total_tokens: int(input.subagents.total_tokens),
    };
  }
  if (Array.isArray(input.mcp_servers_used) && input.mcp_servers_used.length > 0) {
    // Dedupe + sort so JSONL diffs stay stable across record orderings.
    record.mcp_servers_used = [...new Set(input.mcp_servers_used)].sort();
  }
  return record;
}

/**
 * Write a record to the daily JSONL file. The path is computed from the
 * record's started_at field's UTC date so the file boundary is stable
 * regardless of the recorder's local timezone.
 *
 * Returns the absolute path written so callers can log it.
 *
 * @param {object} record  output of buildRecord()
 * @param {string} stateDir  absolute path to .claude/state (or test scratch dir)
 * @returns {string} the path of the JSONL file the record was appended to
 */
export function writeRecord(record, stateDir) {
  if (!record || typeof record !== "object") {
    throw new Error("metrics.writeRecord: record must be an object");
  }
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new Error("metrics.writeRecord: stateDir must be a non-empty string");
  }
  // Reject path-traversal in the skill name as a defence-in-depth
  // measure: skill is interpolated into NOTHING below, but the schema
  // additionalProperties:false will reject malformed records on read,
  // and we'd rather catch it on write.
  if (typeof record.skill !== "string" || record.skill.includes("/") || record.skill.includes("..")) {
    throw new Error(`metrics.writeRecord: invalid skill name ${JSON.stringify(record.skill)}`);
  }
  const date = utcDateFromIso(record.started_at);
  const dir = resolve(stateDir, "metrics");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.jsonl`);
  // Append exactly one JSON line. JSON.stringify on plain objects is
  // deterministic for primitive values (the only kind we accept), so
  // the line bytes don't depend on key insertion order at the schema
  // level — but to be defensively stable, render through an explicit
  // key order.
  const line = JSON.stringify(record) + "\n";
  appendFileSync(file, line);
  return file;
}

/**
 * Convenience: build + write in one shot. Returns the record AND the
 * file path, in case the caller wants to log the trace_id back to the
 * skill state.
 */
export function record(input, stateDir) {
  const r = buildRecord(input);
  const path = writeRecord(r, stateDir);
  return { record: r, path };
}

// ---------- internals ----------

function normaliseTokens(t) {
  if (!t || typeof t !== "object") {
    throw new Error("metrics: tokens must be an object");
  }
  return {
    input: int(t.input),
    output: int(t.output),
    cache_read: int(t.cache_read),
    cache_write: int(t.cache_write),
  };
}

function int(v) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`metrics: token counts must be non-negative finite numbers; got ${v}`);
  }
  return Math.trunc(n);
}

/**
 * Extract the UTC YYYY-MM-DD prefix from an ISO 8601 string. We do not
 * use new Date() round-tripping because the input may already be the
 * canonical "2026-04-28T..." form and we want to preserve the exact
 * date no matter what the host's locale says.
 *
 * @param {string} iso
 * @returns {string}
 */
export function utcDateFromIso(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) {
    throw new Error(`metrics: started_at must be ISO 8601 with date prefix; got ${JSON.stringify(iso)}`);
  }
  return iso.slice(0, 10);
}

// Resolve the state-metrics directory for a given project root. The
// installer (scripts/install.mjs) is the canonical owner of the
// `.claude/state/` path; centralising it here keeps callers consistent
// even when ops.config eventually lets a project relocate it.
export function metricsDirForProject(projectRoot) {
  return resolve(projectRoot, ".claude", "state", "metrics");
}

// Build a portable POSIX-style relative path so callers logging
// `recorded to <path>` get a consistent shape across OSes.
export function toPosixRelative(absPath, base) {
  const rel = absPath.startsWith(base) ? absPath.slice(base.length) : absPath;
  return rel.split(sep).filter(Boolean).join("/");
}

// `dirname` is re-exported only because callers using `metricsDirForProject`
// sometimes want the parent of the metrics dir. Keep this minimal so we
// don't grow a kitchen-sink module.
export { dirname };
