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
  const r = buildRecord({ ...validInput(), parent_trace_id: "t-parent-123" });
  assert.equal(r.parent_trace_id, "t-parent-123");
});

test("buildRecord: mcp_servers_used is deduped + sorted", () => {
  const r = buildRecord({ ...validInput(), mcp_servers_used: ["sqlite", "git", "git", "filesystem"] });
  assert.deepEqual(r.mcp_servers_used, ["filesystem", "git", "sqlite"]);
});

test("buildRecord: rejects negative or non-finite token counts", () => {
  assert.throws(() => buildRecord({ ...validInput(), tokens: { input: -1, output: 0, cache_read: 0, cache_write: 0 } }));
  assert.throws(() => buildRecord({ ...validInput(), tokens: { input: NaN, output: 0, cache_read: 0, cache_write: 0 } }));
});

test("writeRecord: appends one JSONL line per invocation, file keyed by UTC date", () => {
  const dir = tmp();
  try {
    const r = buildRecord(validInput());
    const file = writeRecord(r, dir);
    assert.ok(file.endsWith("metrics/2026-04-28.jsonl"), `unexpected path: ${file}`);
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
