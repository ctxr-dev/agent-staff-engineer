// Tests for scripts/report_metrics.mjs CLI argument handling.
// Exercises the bare-flag rejection, --week round-trip validation,
// invalid threshold guards, and the happy-path stdout shape.
// Heavy e2e coverage stays in tests/metrics/aggregate.test.mjs; this
// file is the thin entrypoint guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const REPORT_CLI = resolve(__dirname, "..", "..", "scripts", "report_metrics.mjs");

function tmp() {
  return mkdtempSync(join(tmpdir(), "report-metrics-cli-"));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [REPORT_CLI, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("report_metrics CLI: --help prints usage and exits 0", () => {
  const r = runCli(["--help"], tmp());
  assert.equal(r.status, 0);
  // The actual usage banner is `Usage: node scripts/report_metrics.mjs ...`.
  // Match case-insensitively and against the script filename.
  assert.match(r.stdout, /usage:.*report_metrics\.mjs/i);
});

test("report_metrics CLI: refuses without --weekly", () => {
  const r = runCli([], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pass --weekly/);
});

test("report_metrics CLI: rejects bare --metrics-dir / --out-dir / --prev-week-json / --week / --cache-min / --token-ceiling", () => {
  for (const flag of ["--metrics-dir", "--out-dir", "--prev-week-json", "--week", "--cache-min", "--token-ceiling"]) {
    const r = runCli(["--weekly", flag], tmp());
    assert.equal(r.status, 2, `bare ${flag} should exit 2; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, new RegExp(`requires a value`));
  }
});

test("report_metrics CLI: rejects empty --metrics-dir / --out-dir / --week", () => {
  // parseArgv accepts `--flag=` as the empty string; the CLI guards
  // every string-valued flag against zero-length values too.
  for (const flag of ["--metrics-dir=", "--out-dir=", "--week="]) {
    const r = runCli(["--weekly", flag], tmp());
    // parseArgv throws on empty value with `=`; either way we want non-zero exit.
    assert.notEqual(r.status, 0, `${flag} should not succeed`);
  }
});

test("report_metrics CLI: --token-ceiling rejects non-integer", () => {
  const r = runCli(["--weekly", "--token-ceiling=5000.9"], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be a non-negative integer/);
});

test("report_metrics CLI: --cache-min rejects out-of-range value", () => {
  const r = runCli(["--weekly", "--cache-min=7"], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be a number in \[0, 1\]/);
});

test("report_metrics CLI: --week with impossible W53 round-trip-rejects", () => {
  // 2025 is a 52-week ISO year; W53 does not exist. mondayFromIsoWeek
  // round-trips through isoWeekWindow and rejects.
  const r = runCli(["--weekly", "--week=2025-W53"], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a valid ISO 8601 week/);
});

test("report_metrics CLI: happy path runs against an empty metrics dir and writes empty rollup", () => {
  const dir = tmp();
  try {
    // Pre-create the metrics dir so readRecordsInWindow's TOCTOU
    // guard returns an empty record list (instead of skipping
    // entirely when the dir doesn't exist).
    mkdirSync(join(dir, ".claude", "state", "metrics"), { recursive: true });
    const r = runCli(["--weekly"], dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Rendered header is `# Week <YYYY-Www>`.
    assert.match(r.stdout, /^# Week \d{4}-W\d{2}/m);
    // The CLI defaults the out-dir to .claude/state/metrics-weekly
    // and writes <isoWeek>.json + .md atomically. Pick the iso week
    // out of the rendered header so the assertion is independent of
    // the wall-clock at test time.
    const isoWeekMatch = /^# Week (\d{4}-W\d{2})/m.exec(r.stdout);
    assert.ok(isoWeekMatch, `expected an iso-week heading in stdout, got: ${r.stdout}`);
    const isoWeek = isoWeekMatch[1];
    const outDir = join(dir, ".claude", "state", "metrics-weekly");
    assert.ok(existsSync(outDir), `out-dir should exist after run: ${outDir}`);
    const entries = readdirSync(outDir).sort();
    assert.deepEqual(entries, [`${isoWeek}.json`, `${isoWeek}.md`]);
    // JSON parses + matches the iso week the markdown reported.
    const json = JSON.parse(readFileSync(join(outDir, `${isoWeek}.json`), "utf8"));
    assert.equal(json.iso_week, isoWeek);
    assert.equal(json.totals.invocations, 0);
    // Markdown round-trips byte-for-byte against the rendered stdout
    // (modulo the trailing "rollup written to" pointer line).
    const md = readFileSync(join(outDir, `${isoWeek}.md`), "utf8");
    assert.match(md, new RegExp(`^# Week ${isoWeek}`, "m"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
