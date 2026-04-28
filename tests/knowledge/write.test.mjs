// Tests for scripts/lib/knowledge/write.mjs
//
// Contract overview:
//   * Steps 1 (atomic markdown write), 2 (local + skill-llm-wiki
//     validate), and 3 (index-rebuild) are HARD-FAIL with rollback:
//     any failure removes the new leaf, and a step-3 failure also
//     re-runs index-rebuild against the post-rollback tree so the
//     index.md siblings do not reference a now-missing leaf.
//   * Step 4 (SQLite frontier reindex marker) is BEST-EFFORT: a marker
//     write failure is reported as a warning, NOT rolled back, since
//     the wiki itself is already consistent and the next session-start
//     incremental reindex can recover by walking the tree.
// Tests inject runSkillLlmWiki + runIndexRebuild + enqueueFrontierReindex
// through _deps so we do not require the real CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeEntry } from "../../scripts/lib/knowledge/write.mjs";

function makeWiki() {
  return mkdtempSync(join(tmpdir(), "knowledge-write-"));
}

const validData = (slug = "pr-iteration-bot-id") => ({
  id: slug,
  type: "leaf",
  depth_role: "leaf",
  focus: "PR iteration must cache bot node IDs per repo",
  covers: ["pr-iteration"],
  parents: ["patterns"],
  kind: "pattern",
  first_seen: "2026-04-10",
  last_verified: "2026-04-28",
  source: "PR #123",
  status: "active",
});

const happyDeps = () => ({
  runSkillLlmWiki: () => ({ ok: true }),
  runIndexRebuild: () => ({ ok: true, scoped: true }),
  enqueueFrontierReindex: () => ({ ok: true }),
});

test("writeEntry: happy path lands the markdown + returns ok", () => {
  const wiki = makeWiki();
  try {
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body content.\n",
    }, happyDeps());
    assert.equal(r.ok, true);
    assert.ok(r.path.endsWith("knowledge/patterns/pr-iteration-bot-id.md"));
    const text = readFileSync(r.path, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /^id: pr-iteration-bot-id$/m);
    assert.match(text, /\nBody content\./);
    assert.deepEqual(r.warnings, []);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: rejects domain/slug shapes that could escape the tree", () => {
  const wiki = makeWiki();
  try {
    const a = writeEntry({ wikiRoot: wiki, domain: "..", slug: "x", data: validData("x"), body: "" }, happyDeps());
    assert.equal(a.ok, false);
    assert.equal(a.step, 0);
    const b = writeEntry({ wikiRoot: wiki, domain: "patterns/extra", slug: "x", data: validData("x"), body: "" }, happyDeps());
    assert.equal(b.ok, false);
    const c = writeEntry({ wikiRoot: wiki, domain: "patterns", slug: "Has Spaces", data: validData("Has Spaces"), body: "" }, happyDeps());
    assert.equal(c.ok, false);
    const d = writeEntry({ wikiRoot: wiki, domain: "patterns", slug: "ok-slug", data: validData("different-id"), body: "" }, happyDeps());
    assert.equal(d.ok, false);
    assert.match(d.error, /must equal slug/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 2 (local schema) failure rolls back the file", () => {
  const wiki = makeWiki();
  try {
    const data = { ...validData(), kind: "rumour" }; // bogus kind
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: data.id,
      data,
      body: "",
    }, happyDeps());
    assert.equal(r.ok, false);
    assert.equal(r.step, 2);
    const path = join(wiki, "knowledge", "patterns", `${data.id}.md`);
    assert.equal(existsSync(path), false, "file must be deleted on rollback");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 2b (skill-llm-wiki validate) failure rolls back the file", () => {
  const wiki = makeWiki();
  try {
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: false, error: "dangling parent" }),
      runIndexRebuild: () => ({ ok: true, scoped: true }),
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.step, 2);
    assert.match(r.error, /dangling parent/);
    const path = join(wiki, "knowledge", "patterns", "pr-iteration-bot-id.md");
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 3 (index-rebuild) failure rolls back the file", () => {
  const wiki = makeWiki();
  try {
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: () => ({ ok: false, error: "rebuild crashed" }),
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.step, 3);
    const path = join(wiki, "knowledge", "patterns", "pr-iteration-bot-id.md");
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 3 failure runs reconcile rebuild after leaf rollback", () => {
  // The atomic contract requires a step-3 failure to also reconcile the
  // index.md siblings against the post-rollback tree. Without this, an
  // index.md update made by the partial rebuild would still reference
  // a now-missing leaf. Verify the reconcile rebuild is invoked AFTER
  // the leaf is removed (so the rebuild operates on a tree without
  // the failed leaf).
  const wiki = makeWiki();
  try {
    const path = join(wiki, "knowledge", "patterns", "pr-iteration-bot-id.md");
    let calls = 0;
    let leafExistsAtReconcile = null;
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: () => {
        calls += 1;
        if (calls === 1) return { ok: false, error: "rebuild crashed" };
        // Second call is the reconcile. Capture the on-disk state so
        // we can assert the leaf is GONE before reconcile runs.
        leafExistsAtReconcile = existsSync(path);
        return { ok: true, scoped: false };
      },
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.step, 3);
    assert.equal(calls, 2, "reconcile rebuild must run after rollback");
    assert.equal(leafExistsAtReconcile, false, "leaf must be deleted BEFORE reconcile rebuild runs");
    assert.equal(existsSync(path), false);
    assert.match(r.error, /leaf removed; indexes reconciled/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 3 + reconcile both fail flag the wiki as inconsistent", () => {
  const wiki = makeWiki();
  try {
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: () => ({ ok: false, error: "rebuild crashed" }),
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.step, 3);
    assert.match(r.error, /reconcile after leaf rollback also failed/);
    assert.match(r.error, /Wiki indexes may be inconsistent/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: full-tree fallback (scoped: false) surfaces a warning, not a failure", () => {
  const wiki = makeWiki();
  try {
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: () => ({ ok: true, scoped: false }),
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /full-tree mode/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 4 (frontier reindex) failure is a soft warning, NOT a rollback", () => {
  const wiki = makeWiki();
  try {
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
      stateDir: join(wiki, ".claude", "state"),
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: () => ({ ok: true, scoped: true }),
      enqueueFrontierReindex: () => ({ ok: false, error: "disk full" }),
    });
    // The wiki is consistent. The frontier marker is the recovery
    // mechanism for the next session. Soft failure: ok stays true.
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /frontier reindex/);
    assert.match(r.warnings[0], /disk full/);
    // The file must still exist on disk.
    const path = join(wiki, "knowledge", "patterns", "pr-iteration-bot-id.md");
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: enqueueFrontierReindex skipped when stateDir omitted (no warning)", () => {
  const wiki = makeWiki();
  try {
    let called = false;
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: () => ({ ok: true, scoped: true }),
      enqueueFrontierReindex: () => { called = true; return { ok: true }; },
    });
    assert.equal(r.ok, true);
    assert.equal(called, false, "step 4 must not run without a stateDir");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
