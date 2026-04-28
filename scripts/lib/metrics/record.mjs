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
// orderedRecord() projects every object level through an explicit
// whitelist: the top-level keys against RECORD_KEY_ORDER, and the
// nested `tokens` / `subagents` objects against their own per-key
// allow-lists. Two callers passing the same logical record write
// byte-identical JSONL lines AND any unknown key the caller has
// reached in to add (after buildRecord returned the object) is
// dropped at write time. That keeps the schema's
// `additionalProperties: false` guarantee load-bearing on write,
// not just on aggregator-side validation.
//
// Cost computation: cost_usd is derived from the four token fields and
// a model rate table. The table covers the rates documented at the
// time of writing; callers may pass `rates` explicitly to override
// (useful in tests and when a model's rate changes between releases).

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  // Resolve the rate by walking a four-step fallback chain:
  //   1. caller's override at rates[model]      (most specific)
  //   2. DEFAULT_RATES[model]                   (known model, just not overridden)
  //   3. caller's rates.default                 (caller's chosen default)
  //   4. DEFAULT_RATES.default                  (last-resort sane number)
  // The DEFAULT_RATES[model] step matters: a caller that overrides
  // pricing for one model should NOT cause every OTHER known model to
  // fall to the caller's default rate. Without this step, a record
  // for claude-opus-4-7 priced through an override map that defines
  // only "some-other-model" + "default" would silently use the
  // (probably-wrong) default-tier price instead of the documented
  // opus rate. The DEFAULT_RATES.default tail keeps cost non-zero
  // even when the override omits both the model AND `default`, so
  // computeCostUsd never throws on a partial map.
  const rate =
    (model && rates && rates[model]) ||
    (model && DEFAULT_RATES[model]) ||
    (rates && rates.default) ||
    DEFAULT_RATES.default;
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
 * tests). The `tokens` object SHOULD carry all four fields
 * (input, output, cache_read, cache_write); missing fields coerce to
 * 0, so a caller that only knows two of them still produces a valid
 * record. Negative or non-finite values throw; the schema's "minimum:
 * 0" constraint is the contract.
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
  // Explicit object guard so a caller passing null / undefined / a
  // primitive gets a stable `metrics.buildRecord:` error instead of a
  // generic `Cannot read properties of null` TypeError thrown by the
  // `input[k]` access in the required-field loop below.
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      `metrics.buildRecord: input must be a plain object; got ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`,
    );
  }
  const required = ["skill", "started_at", "ended_at", "tokens"];
  for (const k of required) {
    if (input[k] == null) throw new Error(`metrics.buildRecord: ${k} is required`);
  }
  // Schema-conformance invariants. buildRecord is documented as
  // producing schema-valid records; surface invariant violations
  // here instead of relying on writeRecord to discover them at JSONL
  // append time. Same patterns the schema enforces.
  if (typeof input.skill !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(input.skill)) {
    throw new Error(`metrics.buildRecord: skill must match /^[a-z0-9][a-z0-9_-]*$/; got ${JSON.stringify(input.skill)}`);
  }
  if (input.parent_trace_id != null && (typeof input.parent_trace_id !== "string" || !/^t-[0-9a-f]{16}$/.test(input.parent_trace_id))) {
    throw new Error(`metrics.buildRecord: parent_trace_id must match /^t-[0-9a-f]{16}$/ when present; got ${JSON.stringify(input.parent_trace_id)}`);
  }
  if (input.trace_id != null && (typeof input.trace_id !== "string" || !/^t-[0-9a-f]{16}$/.test(input.trace_id))) {
    throw new Error(`metrics.buildRecord: trace_id must match /^t-[0-9a-f]{16}$/ when supplied; got ${JSON.stringify(input.trace_id)}`);
  }
  // ISO 8601 shape for started_at + ended_at. utcDateFromIso accepts
  // both Z-form and offset-form and rejects naive timestamps; running
  // it once here surfaces a malformed value at buildRecord time
  // instead of writeRecord time. The result is discarded; we just
  // want the throw on bad input.
  utcDateFromIso(input.started_at, "started_at");
  utcDateFromIso(input.ended_at, "ended_at");
  if (input.exit != null) {
    const validExits = new Set(["success", "halt", "fault", "error", "cancelled"]);
    if (!validExits.has(input.exit)) {
      throw new Error(`metrics.buildRecord: exit must be one of ${[...validExits].join(", ")} when present; got ${JSON.stringify(input.exit)}`);
    }
  }
  if (input.model != null && typeof input.model !== "string") {
    throw new Error(`metrics.buildRecord: model must be a string when present; got ${JSON.stringify(input.model)}`);
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
  // Reject path-traversal AND any path-separator in the skill name.
  // Use an allowlist regex (lowercase alnum + `-` + `_`) — that's a
  // proper superset of every skill name the bundle ships and rules out
  // both POSIX `/` and Windows `\\` separators in one check, plus `..`
  // segments. additionalProperties:false on the read schema is the
  // second line of defence; this is the first.
  if (typeof record.skill !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(record.skill)) {
    throw new Error(`metrics.writeRecord: invalid skill name ${JSON.stringify(record.skill)} (expected /^[a-z0-9][a-z0-9_-]*$/)`);
  }
  // Validate the nested `tokens` shape too: all four keys must be
  // non-negative finite numbers. Without this check, a caller that
  // hand-built a record (skipping buildRecord) could land a JSONL
  // line whose tokens object is missing fields or carries strings;
  // the read schema would reject it on aggregator-side validation,
  // but the file would already be on disk. Fail at write time so the
  // bad record never lands.
  if (record.tokens == null || typeof record.tokens !== "object") {
    throw new Error("metrics.writeRecord: record.tokens must be an object with input/output/cache_read/cache_write");
  }
  for (const k of ["input", "output", "cache_read", "cache_write"]) {
    const v = record.tokens[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`metrics.writeRecord: record.tokens.${k} must be a non-negative finite number; got ${JSON.stringify(v)}`);
    }
  }
  // Validate the remaining required top-level fields. A caller that
  // bypassed buildRecord (or mutated its output) could otherwise land
  // a JSONL line with a missing trace_id, an unparseable started_at,
  // or a negative cost, and the read schema would only reject it
  // later (when it is already on disk and may have skewed the rollup
  // for one or more weeks). Fail at write time so the bad record
  // never lands on disk.
  if (typeof record.trace_id !== "string" || !/^t-[0-9a-f]{16}$/.test(record.trace_id)) {
    throw new Error(`metrics.writeRecord: record.trace_id must match /^t-[0-9a-f]{16}$/; got ${JSON.stringify(record.trace_id)}`);
  }
  if (record.parent_trace_id != null) {
    if (typeof record.parent_trace_id !== "string" || !/^t-[0-9a-f]{16}$/.test(record.parent_trace_id)) {
      throw new Error(`metrics.writeRecord: record.parent_trace_id must match /^t-[0-9a-f]{16}$/ when present; got ${JSON.stringify(record.parent_trace_id)}`);
    }
  }
  if (typeof record.started_at !== "string") {
    throw new Error(`metrics.writeRecord: record.started_at must be an ISO 8601 string; got ${JSON.stringify(record.started_at)}`);
  }
  if (typeof record.ended_at !== "string") {
    throw new Error(`metrics.writeRecord: record.ended_at must be an ISO 8601 string; got ${JSON.stringify(record.ended_at)}`);
  }
  // utcDateFromIso below already enforces ISO 8601 shape on started_at;
  // re-run it now on ended_at so a malformed value surfaces here, not
  // on the next aggregator pass.
  utcDateFromIso(record.ended_at, "ended_at");
  if (typeof record.cost_usd !== "number" || !Number.isFinite(record.cost_usd) || record.cost_usd < 0) {
    throw new Error(`metrics.writeRecord: record.cost_usd must be a non-negative finite number; got ${JSON.stringify(record.cost_usd)}`);
  }
  const validExits = new Set(["success", "halt", "fault", "error", "cancelled"]);
  if (!validExits.has(record.exit)) {
    throw new Error(`metrics.writeRecord: record.exit must be one of ${[...validExits].join(", ")}; got ${JSON.stringify(record.exit)}`);
  }
  // Optional top-level fields. orderedRecord copies model and
  // mcp_servers_used through verbatim; the schema specifies their
  // shapes (string for model; non-empty string array for
  // mcp_servers_used). A caller that mutated the record after
  // buildRecord could otherwise land schema-invalid JSONL on disk —
  // valid JSON, but rejected by every downstream consumer that ran
  // ajv against the schema. Validate here so the bad bytes never
  // reach disk.
  if (record.model !== undefined && typeof record.model !== "string") {
    throw new Error(`metrics.writeRecord: record.model must be a string when present; got ${JSON.stringify(record.model)}`);
  }
  if (record.mcp_servers_used !== undefined) {
    if (!Array.isArray(record.mcp_servers_used)) {
      throw new Error(`metrics.writeRecord: record.mcp_servers_used must be an array of strings when present; got ${JSON.stringify(record.mcp_servers_used)}`);
    }
    const seen = new Set();
    for (const item of record.mcp_servers_used) {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`metrics.writeRecord: record.mcp_servers_used items must be non-empty strings; got ${JSON.stringify(item)}`);
      }
      if (seen.has(item)) {
        throw new Error(`metrics.writeRecord: record.mcp_servers_used must contain unique items (schema uniqueItems:true); got duplicate ${JSON.stringify(item)}`);
      }
      seen.add(item);
    }
  }
  if (record.subagents !== undefined) {
    const sa = record.subagents;
    if (sa == null || typeof sa !== "object") {
      throw new Error(`metrics.writeRecord: record.subagents must be an object when present; got ${JSON.stringify(sa)}`);
    }
    for (const k of ["count", "total_tokens"]) {
      const v = sa[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        throw new Error(`metrics.writeRecord: record.subagents.${k} must be a non-negative integer when present; got ${JSON.stringify(v)}`);
      }
    }
  }
  const date = utcDateFromIso(record.started_at, "started_at");
  const dir = resolve(stateDir, "metrics");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.jsonl`);
  // Render the record with an explicit key order so the JSONL bytes
  // don't depend on caller mutation order. Two callers that pass the
  // same logical record produce byte-identical lines, which keeps
  // diffs of the JSONL stable across recorder versions.
  const line = JSON.stringify(orderedRecord(record)) + "\n";
  appendFileSync(file, line);
  return file;
}

// Canonical key order for a record on disk. Matches the field order in
// schemas/metrics-record.schema.json.
const RECORD_KEY_ORDER = [
  "trace_id",
  "parent_trace_id",
  "skill",
  "started_at",
  "ended_at",
  "model",
  "tokens",
  "cost_usd",
  "subagents",
  "mcp_servers_used",
  "exit",
];

// Per-nested-object key whitelists. Both `tokens` and `subagents` set
// `additionalProperties: false` in their schemas; mirroring those
// allow-lists here means a caller that mutates the object returned
// from buildRecord (e.g. to smuggle a `tokens.thinking` count) gets
// the unknown key dropped at write time, the same way an unknown
// top-level key gets dropped.
const TOKENS_KEY_ORDER = ["input", "output", "cache_read", "cache_write"];
const SUBAGENTS_KEY_ORDER = ["count", "total_tokens"];

function orderedRecord(record) {
  // Whitelist-only at every layer: drop any key the schema doesn't
  // know about. The record schema sets `additionalProperties: false`
  // at top-level AND on the nested `tokens` and `subagents` objects;
  // a record that smuggled an extra field through writeRecord would
  // be rejected on read. Enforcing the same contract on write keeps
  // the privacy guarantee strict and makes the recorder's shape
  // predictable for downstream consumers.
  const out = {};
  for (const k of RECORD_KEY_ORDER) {
    if (!(k in record) || record[k] === undefined) continue;
    if (k === "tokens") out[k] = projectKeys(record[k], TOKENS_KEY_ORDER);
    else if (k === "subagents") out[k] = projectKeys(record[k], SUBAGENTS_KEY_ORDER);
    else out[k] = record[k];
  }
  return out;
}

function projectKeys(obj, keys) {
  // Pure projection: take only the keys we know, in canonical order,
  // dropping unknown keys silently. The caller is responsible for
  // having validated the values via buildRecord; this helper is the
  // last-mile shape filter.
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
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
export function utcDateFromIso(iso, fieldName = "timestamp") {
  if (typeof iso !== "string") {
    throw new Error(`metrics: ${fieldName} must be ISO 8601; got ${JSON.stringify(iso)}`);
  }
  // Two acceptable shapes:
  //   1. Strict UTC form ending in `Z`: parse via Date to reject
  //      impossible dates like 2026-99-99T...Z (the regex shape would
  //      otherwise pass and produce an impossible YYYY-MM-DD prefix
  //      that breaks window selection downstream).
  //   2. ISO with a timezone offset: convert to UTC via Date so the
  //      file-boundary date reflects the UTC calendar day, NOT the
  //      caller's local day. Without this, `2026-04-28T23:30:00-05:00`
  //      (an instant on UTC 2026-04-29) would land in the 04-28 file.
  // Both branches now go through the same Date parse + UTC extract;
  // the regex pre-filter still rejects shapes the spec disallows
  // (e.g. naive timestamps with no zone designator).
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(iso) ||
      /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:?\d{2})$/.test(iso)) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`metrics: ${fieldName} unparseable as ISO 8601; got ${JSON.stringify(iso)}`);
    }
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  throw new Error(
    `metrics: ${fieldName} must be ISO 8601 with Z or +/-HH:MM offset; got ${JSON.stringify(iso)}`,
  );
}

// Resolve the .claude/state directory for a given project root. The
// installer (scripts/install.mjs) is the canonical owner of the
// `.claude/state/` path; centralising it here keeps callers consistent
// even when ops.config eventually lets a project relocate it.
//
// IMPORTANT: writeRecord() expects this exact path (the parent of the
// metrics/ subdir) and appends `metrics/<date>.jsonl` itself. A caller
// passing `<root>/.claude/state/metrics` would produce a nested
// `metrics/metrics/<date>.jsonl` — the helper below returns the
// correct value. The legacy `metricsDirForProject` alias is kept as a
// deprecated re-export for any out-of-tree caller that already wired
// against it; it now points at the same `.claude/state` parent so its
// output is the right one to feed writeRecord.
export function stateDirForProject(projectRoot) {
  return resolve(projectRoot, ".claude", "state");
}

// @deprecated use stateDirForProject; retained as an alias so existing
// callers pass the right path to writeRecord (which appends `metrics`).
export function metricsDirForProject(projectRoot) {
  return stateDirForProject(projectRoot);
}

// Build a portable POSIX-style relative path so callers logging
// `recorded to <path>` get a consistent shape across OSes. Uses
// path.relative() rather than a raw startsWith strip so unrelated
// path prefixes (e.g. base "/a/b" vs absPath "/a/bad/file") don't
// produce a misleading "ad/file"; relative() emits "../bad/file"
// instead.
export function toPosixRelative(absPath, base) {
  const rel = relative(base, absPath);
  return rel.split(sep).filter(Boolean).join("/");
}

// `dirname` is re-exported only because callers using `metricsDirForProject`
// sometimes want the parent of the metrics dir. Keep this minimal so we
// don't grow a kitchen-sink module.
export { dirname };
