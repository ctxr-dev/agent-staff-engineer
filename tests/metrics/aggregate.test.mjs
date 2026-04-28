// Tests for scripts/lib/metrics/aggregate.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isoWeekWindow,
  isoWeekDesignation,
  readRecordsInWindow,
  aggregate,
  renderMarkdown,
} from "../../scripts/lib/metrics/aggregate.mjs";
import { buildRecord, writeRecord } from "../../scripts/lib/metrics/record.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "metrics-aggregate-"));
}

test("isoWeekWindow: Monday-anchored, half-open interval", () => {
  // 2026-04-28 is a Tuesday in ISO week 18 (Monday: 2026-04-27).
  // ISO 8601 numbering: Jan 4 lives in W01 by definition; counting
  // Mondays forward, 2026-04-27 starts W18.
  const w = isoWeekWindow(new Date("2026-04-28T10:00:00Z"));
  assert.equal(w.start.toISOString(), "2026-04-27T00:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-05-04T00:00:00.000Z");
  assert.equal(w.isoWeek, "2026-W18");
});

test("isoWeekDesignation: ISO 8601 year + week pair", () => {
  // 2024 has 52 ISO weeks; 2025-01-01 is a Wednesday so it falls in 2025-W01.
  // Use Mondays.
  assert.equal(isoWeekDesignation(new Date(Date.UTC(2025, 0, 6))), "2025-W02"); // 6 Jan = Mon of W02
  assert.equal(isoWeekDesignation(new Date(Date.UTC(2024, 11, 30))), "2025-W01"); // ISO year flips
});

test("readRecordsInWindow: only files inside [start, end) are read", () => {
  const dir = tmp();
  try {
    const m = join(dir, "metrics");
    mkdirSync(m, { recursive: true });
    writeFileSync(join(m, "2026-04-26.jsonl"), JSON.stringify({ skill: "x", tokens: {} }) + "\n"); // before window
    writeFileSync(join(m, "2026-04-27.jsonl"), JSON.stringify({ skill: "in", tokens: {} }) + "\n"); // start of window
    writeFileSync(join(m, "2026-05-03.jsonl"), JSON.stringify({ skill: "in", tokens: {} }) + "\n"); // last day in
    writeFileSync(join(m, "2026-05-04.jsonl"), JSON.stringify({ skill: "out", tokens: {} }) + "\n"); // exclusive upper
    const w = isoWeekWindow(new Date("2026-04-28T10:00:00Z"));
    const records = readRecordsInWindow(m, w.start, w.end);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.skill), ["in", "in"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecordsInWindow: malformed lines are skipped, valid lines are kept", () => {
  const dir = tmp();
  try {
    const m = join(dir, "metrics");
    mkdirSync(m, { recursive: true });
    writeFileSync(
      join(m, "2026-04-27.jsonl"),
      [
        JSON.stringify({ skill: "ok", tokens: { input: 1, output: 0, cache_read: 0, cache_write: 0 } }),
        "{ broken json",
        JSON.stringify({ skill: "also-ok", tokens: { input: 2, output: 0, cache_read: 0, cache_write: 0 } }),
        "",
      ].join("\n"),
    );
    const w = isoWeekWindow(new Date("2026-04-28T10:00:00Z"));
    const records = readRecordsInWindow(m, w.start, w.end);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.skill).sort(), ["also-ok", "ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: per-skill totals + cache_hit_rate from real records", () => {
  const dir = tmp();
  try {
    const r1 = buildRecord({
      skill: "dev-loop",
      started_at: "2026-04-27T10:00:00Z",
      ended_at: "2026-04-27T10:01:00Z",
      tokens: { input: 1000, output: 500, cache_read: 4000, cache_write: 200 },
      model: "claude-opus-4-7",
    });
    const r2 = buildRecord({
      skill: "dev-loop",
      started_at: "2026-04-28T10:00:00Z",
      ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 500, output: 300, cache_read: 1500, cache_write: 100 },
      model: "claude-opus-4-7",
    });
    const r3 = buildRecord({
      skill: "pr-iteration",
      started_at: "2026-04-28T11:00:00Z",
      ended_at: "2026-04-28T11:00:05Z",
      tokens: { input: 200, output: 100, cache_read: 800, cache_write: 0 },
      model: "claude-haiku-4-5",
    });
    writeRecord(r1, dir);
    writeRecord(r2, dir);
    writeRecord(r3, dir);
    const w = isoWeekWindow(new Date("2026-04-28T10:00:00Z"));
    const records = readRecordsInWindow(join(dir, "metrics"), w.start, w.end);
    const out = aggregate(records, { isoWeek: w.isoWeek });
    assert.equal(out.iso_week, "2026-W18");
    // Totals: 3 invocations, sum cost from per-record cost.
    assert.equal(out.totals.invocations, 3);
    // Per-skill rows lex-sorted: dev-loop then pr-iteration.
    assert.equal(out.per_skill.length, 2);
    assert.equal(out.per_skill[0].skill, "dev-loop");
    assert.equal(out.per_skill[0].invocations, 2);
    assert.equal(out.per_skill[1].skill, "pr-iteration");
    assert.equal(out.per_skill[1].invocations, 1);
    // dev-loop total cache_read = 4000 + 1500; total input = 1500;
    // hit rate = 5500 / (1500 + 5500) = 0.7857...
    assert.ok(out.per_skill[0].cache_hit_rate > 0.78 && out.per_skill[0].cache_hit_rate < 0.80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: sub-invocations fold into parent skill, never appear as their own row", () => {
  const dir = tmp();
  try {
    const parent = buildRecord({
      skill: "dev-loop",
      started_at: "2026-04-28T10:00:00Z",
      ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 1000, output: 500, cache_read: 0, cache_write: 0 },
    });
    const sub = buildRecord({
      skill: "explorer",
      started_at: "2026-04-28T10:00:10Z",
      ended_at: "2026-04-28T10:00:25Z",
      tokens: { input: 500, output: 200, cache_read: 0, cache_write: 0 },
      parent_trace_id: parent.trace_id,
    });
    writeRecord(parent, dir);
    writeRecord(sub, dir);
    const w = isoWeekWindow(new Date("2026-04-28T10:00:00Z"));
    const records = readRecordsInWindow(join(dir, "metrics"), w.start, w.end);
    const out = aggregate(records, { isoWeek: w.isoWeek });
    // Only one skill row: "dev-loop". "explorer" must NOT appear.
    assert.deepEqual(out.per_skill.map((r) => r.skill), ["dev-loop"]);
    // Invocations counts top-level only.
    assert.equal(out.per_skill[0].invocations, 1);
    // But token totals include the sub-invocation's tokens.
    assert.equal(out.totals.tokens.input, 1500);
    assert.equal(out.totals.tokens.output, 700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: orphan sub-invocations are dropped, never appear as a phantom row", () => {
  // A sub-invocation whose parent record is NOT present in this batch
  // (because the parent ran in a different ISO week or was filtered
  // out) is "orphaned". The contract: orphans are dropped from the
  // rollup entirely, never surfaced as their own per_skill row. This
  // keeps invocation counts stable at week boundaries — a sub run on
  // Sunday whose parent ran on Monday must not flip between "folded"
  // and "phantom" depending on the aggregation window.
  const records = [
    {
      trace_id: "child-1", skill: "explorer", parent_trace_id: "parent-not-here",
      started_at: "2026-04-28T10:00:00Z", ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 999, output: 999, cache_read: 0, cache_write: 0 },
      cost_usd: 0.50, exit: "success",
    },
  ];
  const w = isoWeekWindow(new Date("2026-04-28T10:00:00Z"));
  const out = aggregate(records, { isoWeek: w.isoWeek });
  assert.equal(out.per_skill.length, 0, "orphan sub must not surface as a row");
  assert.equal(out.totals.invocations, 0, "orphan sub must not count as an invocation");
  assert.equal(out.totals.cost_usd, 0, "orphan sub cost is dropped");
  assert.equal(out.totals.tokens.input, 0, "orphan sub tokens are dropped");
});

test("aggregate: thresholds drive red flags, sorted by skill then kind", () => {
  // Synthetic records where dev-loop has a low cache hit and a big avg.
  const records = [
    {
      trace_id: "t1", skill: "dev-loop", parent_trace_id: null,
      started_at: "2026-04-28T10:00:00Z", ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 10000, output: 0, cache_read: 0, cache_write: 0 },
      cost_usd: 0.15, exit: "success",
    },
    {
      trace_id: "t2", skill: "pr-iteration", parent_trace_id: null,
      started_at: "2026-04-28T11:00:00Z", ended_at: "2026-04-28T11:00:05Z",
      tokens: { input: 100, output: 0, cache_read: 1000, cache_write: 0 },
      cost_usd: 0.001, exit: "success",
    },
  ];
  const out = aggregate(records, {
    isoWeek: "2026-W18",
    thresholds: { cache_hit_rate_min: 0.7, per_skill_token_ceiling: 5000 },
  });
  // dev-loop fires both flags; pr-iteration fires neither.
  assert.equal(out.red_flags.length, 2);
  assert.deepEqual(out.red_flags.map((f) => f.skill), ["dev-loop", "dev-loop"]);
  // Within the same skill, sorted by kind name lex.
  assert.deepEqual(out.red_flags.map((f) => f.kind), ["avg_tokens_above_ceiling", "cache_hit_rate_below_min"]);
});

test("aggregate: delta_vs_prev null for new skills, fractional for known ones", () => {
  const records = [
    {
      trace_id: "t1", skill: "dev-loop", parent_trace_id: null,
      started_at: "2026-04-28T10:00:00Z", ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 100, output: 0, cache_read: 0, cache_write: 0 },
      cost_usd: 0.10, exit: "success",
    },
    {
      trace_id: "t2", skill: "incident-intake", parent_trace_id: null,
      started_at: "2026-04-28T11:00:00Z", ended_at: "2026-04-28T11:00:05Z",
      tokens: { input: 100, output: 0, cache_read: 0, cache_write: 0 },
      cost_usd: 0.05, exit: "success",
    },
  ];
  const previousAvgCostBySkill = new Map([["dev-loop", 0.13]]);
  const out = aggregate(records, { isoWeek: "2026-W18", previousAvgCostBySkill });
  const dev = out.per_skill.find((r) => r.skill === "dev-loop");
  const intake = out.per_skill.find((r) => r.skill === "incident-intake");
  // (0.10 - 0.13) / 0.13 ~= -0.2308
  assert.ok(Math.abs(dev.delta_vs_prev - (-0.2308)) < 0.001);
  assert.equal(intake.delta_vs_prev, null);
});

test("aggregate: deterministic JSON output (re-runs are byte-identical)", () => {
  const records = [
    {
      trace_id: "t1", skill: "dev-loop", parent_trace_id: null,
      started_at: "2026-04-28T10:00:00Z", ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 1000, output: 500, cache_read: 4000, cache_write: 200 },
      cost_usd: 0.15, exit: "success",
    },
  ];
  const a = JSON.stringify(aggregate(records, { isoWeek: "2026-W18" }));
  const b = JSON.stringify(aggregate(records, { isoWeek: "2026-W18" }));
  assert.equal(a, b);
});

test("renderMarkdown: contains header + per-skill table + red-flags section", () => {
  const records = [
    {
      trace_id: "t1", skill: "dev-loop", parent_trace_id: null,
      started_at: "2026-04-28T10:00:00Z", ended_at: "2026-04-28T10:00:30Z",
      tokens: { input: 10000, output: 0, cache_read: 0, cache_write: 0 },
      cost_usd: 0.15, exit: "success",
    },
  ];
  const out = aggregate(records, {
    isoWeek: "2026-W18",
    thresholds: { cache_hit_rate_min: 0.7 },
  });
  const md = renderMarkdown(out);
  assert.match(md, /^# Week 2026-W18\n/);
  assert.match(md, /Total cost: \$0\.15 across 1 skill invocations/);
  assert.match(md, /\| skill \| invocations \|/);
  assert.match(md, /Red flags:/);
});
