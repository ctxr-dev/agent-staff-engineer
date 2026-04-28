// Tests for scripts/lib/metrics/record.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildRecord,
  computeCostUsd,
  newTraceId,
  utcDateFromIso,
  writeRecord,
  record,
  DEFAULT_RATES,
} from "../../scripts/lib/metrics/record.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "metrics-record-"));
}

const validInput = () => ({
  skill: "dev-loop",
  started_at: "2026-04-28T10:00:00.000Z",
  ended_at: "2026-04-28T10:01:00.000Z",
  tokens: { input: 1000, output: 500, cache_read: 4000, cache_write: 200 },
  model: "claude-opus-4-7",
});

test("computeCostUsd: applies per-million-token rates and rounds to 6 dp", () => {
  const cost = computeCostUsd(
    { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 },
    "claude-opus-4-7",
  );
  assert.equal(cost, DEFAULT_RATES["claude-opus-4-7"].input);
});

test("computeCostUsd: unknown model falls back to default rates (no silent zero)", () => {
  const cost = computeCostUsd(
    { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 },
    "claude-future-99",
  );
  assert.equal(cost, DEFAULT_RATES.default.input);
});

test("computeCostUsd: rates override is honoured", () => {
  const cost = computeCostUsd(
    { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 },
    "x",
    { x: { input: 2.5, output: 0, cache_read: 0, cache_write: 0 }, default: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  );
  assert.equal(cost, 2.5);
});

test("newTraceId: returns a t- prefixed hex id, unique per call", () => {
  const a = newTraceId();
  const b = newTraceId();
  assert.match(a, /^t-[0-9a-f]{16}$/);
  assert.match(b, /^t-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

test("utcDateFromIso: returns the YYYY-MM-DD prefix", () => {
  assert.equal(utcDateFromIso("2026-04-28T23:59:59.000Z"), "2026-04-28");
  assert.equal(utcDateFromIso("2026-12-31T00:00:00.000Z"), "2026-12-31");
  assert.throws(() => utcDateFromIso("not-iso"));
  assert.throws(() => utcDateFromIso(null));
});

test("buildRecord: rejects non-object inputs with a stable error", () => {
  // Without the explicit object guard at the top of buildRecord, these
  // inputs threw a generic `Cannot read properties of null/undefined`
  // TypeError from the input[k] access in the required-field loop. The
  // guard surfaces a stable `metrics.buildRecord:` message instead so
  // callers (and human ops) get one diagnostic shape they can match on.
  assert.throws(() => buildRecord(null), /metrics\.buildRecord: input must be a plain object/);
  assert.throws(() => buildRecord(undefined), /metrics\.buildRecord: input must be a plain object/);
  assert.throws(() => buildRecord(42), /metrics\.buildRecord: input must be a plain object/);
  assert.throws(() => buildRecord("string"), /metrics\.buildRecord: input must be a plain object/);
  assert.throws(() => buildRecord([]), /metrics\.buildRecord: input must be a plain object/);
});

test("buildRecord: required fields enforced", () => {
  assert.throws(() => buildRecord({}), /skill is required/);
  assert.throws(
    () => buildRecord({ skill: "x", started_at: "2026-04-28T00:00:00Z" }),
    /ended_at is required/,
  );
  assert.throws(
    () => buildRecord({ ...validInput(), tokens: undefined }),
    /tokens is required/,
  );
});

test("buildRecord: produces a schema-conformant object with all required fields", () => {
  const r = buildRecord(validInput());
  assert.ok(typeof r.trace_id === "string");
  assert.equal(r.parent_trace_id, null);
  assert.equal(r.skill, "dev-loop");
  assert.equal(r.exit, "success");
  assert.deepEqual(r.tokens, { input: 1000, output: 500, cache_read: 4000, cache_write: 200 });
  assert.equal(r.model, "claude-opus-4-7");
  assert.ok(typeof r.cost_usd === "number" && r.cost_usd > 0);
});

test("buildRecord: sub-invocation carries parent_trace_id", () => {
  // Use a real trace-id-shaped value (matches schema pattern
  // ^t-[0-9a-f]{16}$) so the test does not encode an invalid shape
  // that buildRecord's pattern check would reject.
  const parentTraceId = newTraceId();
  const r = buildRecord({ ...validInput(), parent_trace_id: parentTraceId });
  assert.equal(r.parent_trace_id, parentTraceId);
});

test("buildRecord: mcp_servers_used is deduped + sorted", () => {
  const r = buildRecord({ ...validInput(), mcp_servers_used: ["sqlite", "git", "git", "filesystem"] });
  assert.deepEqual(r.mcp_servers_used, ["filesystem", "git", "sqlite"]);
});

test("buildRecord: rejects negative or non-finite token counts", () => {
  assert.throws(() => buildRecord({ ...validInput(), tokens: { input: -1, output: 0, cache_read: 0, cache_write: 0 } }));
  assert.throws(() => buildRecord({ ...validInput(), tokens: { input: NaN, output: 0, cache_read: 0, cache_write: 0 } }));
});

test("writeRecord: rejects records whose tokens shape is malformed", () => {
  // Defends against hand-built records that skip buildRecord and would
  // otherwise land malformed JSONL on disk. additionalProperties:false
  // on the read schema would reject these on the next aggregator run,
  // but the bad bytes are already on disk by then; fail at write time.
  const dir = tmp();
  try {
    const r = buildRecord(validInput());
    // Missing token field
    const missing = { ...r, tokens: { input: 0, output: 0, cache_read: 0 } };
    assert.throws(() => writeRecord(missing, dir), /tokens\.cache_write/);
    // Wrong type
    const wrongType = { ...r, tokens: { input: "10", output: 0, cache_read: 0, cache_write: 0 } };
    assert.throws(() => writeRecord(wrongType, dir), /tokens\.input/);
    // Missing tokens object entirely
    const noTokens = { ...r, tokens: undefined };
    assert.throws(() => writeRecord(noTokens, dir), /tokens must be an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeCostUsd: known-model fallback uses DEFAULT_RATES[model] before caller's default", () => {
  // A caller's partial override map MUST NOT downgrade pricing for a
  // KNOWN model that simply isn't in the override. The fallback chain:
  // (1) rates[model] (2) DEFAULT_RATES[model] (3) rates.default
  // (4) DEFAULT_RATES.default. Step 2 catches this case: the override
  // applies where the caller asked, but every other DOCUMENTED model
  // continues to price through DEFAULT_RATES.
  const tokens = { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };
  const partial = {
    "some-other-model": { input: 999, output: 999, cache_read: 999, cache_write: 999 },
    default: { input: 999, output: 999, cache_read: 999, cache_write: 999 },
  };
  const cost = computeCostUsd(tokens, "claude-opus-4-7", partial);
  assert.equal(
    cost,
    DEFAULT_RATES["claude-opus-4-7"].input,
    "known model price must come from DEFAULT_RATES, not the caller's default",
  );
});

test("computeCostUsd: truly-unknown model with empty override falls back to DEFAULT_RATES.default", () => {
  // Last-resort tail of the fallback chain. A caller passing a partial
  // override map with NEITHER the model NOR a `default` entry, AND a
  // model name that is unknown to DEFAULT_RATES, lands on
  // DEFAULT_RATES.default. The previous code threw "Cannot read
  // properties of undefined" on this path.
  const tokens = { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };
  const partial = { "some-other-model": { input: 1, output: 1, cache_read: 1, cache_write: 1 } };
  const cost = computeCostUsd(tokens, "totally-unknown-model", partial);
  assert.equal(cost, DEFAULT_RATES.default.input);
});

test("writeRecord: nested whitelist drops unknown keys mutated onto tokens / subagents", () => {
  // The schema sets additionalProperties: false at top level AND on the
  // nested `tokens` and `subagents` objects. orderedRecord() now mirrors
  // that contract on write: a caller that mutates the buildRecord
  // output to add a non-schema field at any layer gets the unknown
  // field dropped at JSONL serialisation time, the same way an unknown
  // top-level key is dropped. Without nested projection the schema
  // guarantee would only hold on read, after a downstream tool tripped
  // over the smuggled field.
  const dir = tmp();
  try {
    const r = buildRecord({
      ...validInput(),
      subagents: { count: 1, total_tokens: 100 },
    });
    // Mutate after buildRecord to mimic a sloppy caller that reaches
    // into the returned object.
    r.tokens.thinking = 9999;
    r.subagents.parent_id = "t-leak";
    r.unexpected_top = "leak";
    const file = writeRecord(r, dir);
    const body = readFileSync(file, "utf8");
    const parsed = JSON.parse(body.split("\n")[0]);
    assert.deepEqual(Object.keys(parsed.tokens), ["input", "output", "cache_read", "cache_write"]);
    assert.deepEqual(Object.keys(parsed.subagents), ["count", "total_tokens"]);
    assert.equal(parsed.unexpected_top, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRecord: appends one JSONL line per invocation, file keyed by UTC date", () => {
  const dir = tmp();
  try {
    const r = buildRecord(validInput());
    const file = writeRecord(r, dir);
    // Use join() for the suffix so the assertion is portable across
    // POSIX (`/`) and Windows (`\`) path separators.
    assert.ok(file.endsWith(join("metrics", "2026-04-28.jsonl")), `unexpected path: ${file}`);
    const body = readFileSync(file, "utf8");
    // Single line + trailing newline.
    assert.equal(body.split("\n").length, 2);
    assert.equal(body.split("\n")[1], "");
    const parsed = JSON.parse(body.split("\n")[0]);
    assert.equal(parsed.skill, "dev-loop");
    assert.equal(parsed.cost_usd, r.cost_usd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRecord: appends multiple invocations in order to the same daily file", () => {
  const dir = tmp();
  try {
    const r1 = buildRecord(validInput());
    const r2 = buildRecord({ ...validInput(), skill: "pr-iteration" });
    writeRecord(r1, dir);
    writeRecord(r2, dir);
    const file = readdirSync(join(dir, "metrics"))[0];
    const lines = readFileSync(join(dir, "metrics", file), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).skill, "dev-loop");
    assert.equal(JSON.parse(lines[1]).skill, "pr-iteration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRecord: rejects path-traversal in skill name", () => {
  const dir = tmp();
  try {
    const r = buildRecord(validInput());
    r.skill = "../etc/passwd";
    assert.throws(() => writeRecord(r, dir), /invalid skill name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRecord: invocations on different dates land in different files", () => {
  const dir = tmp();
  try {
    const r1 = buildRecord({ ...validInput(), started_at: "2026-04-28T23:59:59.000Z", ended_at: "2026-04-28T23:59:59.500Z" });
    const r2 = buildRecord({ ...validInput(), started_at: "2026-04-29T00:00:00.000Z", ended_at: "2026-04-29T00:00:01.000Z" });
    writeRecord(r1, dir);
    writeRecord(r2, dir);
    const files = readdirSync(join(dir, "metrics")).sort();
    assert.deepEqual(files, ["2026-04-28.jsonl", "2026-04-29.jsonl"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record: convenience build+write returns both the record and the path", () => {
  const dir = tmp();
  try {
    const result = record(validInput(), dir);
    assert.ok(result.path.endsWith("2026-04-28.jsonl"));
    assert.equal(result.record.skill, "dev-loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
