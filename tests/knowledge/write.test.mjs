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

test("writeEntry: rollback restores the previous file contents on a same-path UPDATE failure", () => {
  // Step 0 explicitly allows a same-path update. The atomic step-1 write
  // replaces the previous version on disk, so a subsequent step-2 / step-3
  // failure with a naive "delete on rollback" would silently lose the
  // user's prior entry. Verify the snapshot-and-restore contract: the
  // file on disk after rollback equals what was there before writeEntry
  // was called.
  const wiki = makeWiki();
  try {
    // First write succeeds and lands a known body so we can detect
    // mutation on rollback.
    const r1 = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "rolling-stone",
      data: validData("rolling-stone"),
      body: "ORIGINAL.\n",
    }, happyDeps());
    assert.equal(r1.ok, true, `seed write should succeed: ${r1.error || ""}`);
    const path = r1.path;
    const before = readFileSync(path, "utf8");
    // Second write (same path => UPDATE) fails at step 2b. Rollback
    // must restore the original bytes, not delete the file.
    const r2 = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "rolling-stone",
      data: validData("rolling-stone"),
      body: "REPLACEMENT.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: false, error: "boom" }),
      runIndexRebuild: () => ({ ok: true, scoped: true }),
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.step, 2);
    assert.ok(existsSync(path), "prior version must still exist after rollback");
    const after = readFileSync(path, "utf8");
    assert.equal(after, before, "rollback must restore the original bytes byte-for-byte");
    assert.match(after, /ORIGINAL/);
    assert.doesNotMatch(after, /REPLACEMENT/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 0 collision detection refuses to create a duplicate id under a different domain", () => {
  // Schema enforces single-segment ids, so two entries with id "foo"
  // could land under knowledge/patterns/foo.md AND
  // knowledge/incidents/foo.md if writeEntry let them. They wouldn't —
  // step 0 walks the tree, finds the existing path, and refuses.
  // Updates to the SAME path are not collisions (data.id === slug, the
  // existing match equals the target path).
  const wiki = makeWiki();
  try {
    const r1 = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "shared-id",
      data: validData("shared-id"),
      body: "First.\n",
    }, happyDeps());
    assert.equal(r1.ok, true, `first write should succeed: ${r1.error || ""}`);
    // Same id, different domain: must be refused.
    const r2 = writeEntry({
      wikiRoot: wiki,
      domain: "incidents",
      slug: "shared-id",
      data: validData("shared-id"),
      body: "Second.\n",
    }, happyDeps());
    assert.equal(r2.ok, false);
    assert.equal(r2.step, 0);
    assert.match(r2.error, /already exists/);
    assert.match(r2.error, /knowledge\/patterns\/shared-id\.md/);
    // Same id, SAME domain: that's an UPDATE, must be allowed.
    const r3 = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "shared-id",
      data: validData("shared-id"),
      body: "Updated.\n",
    }, happyDeps());
    assert.equal(r3.ok, true, `same-path update should succeed: ${r3.error || ""}`);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeEntry: step 0 collision detection catches archived collisions too", () => {
  // The default query semantics exclude status:"archived" — but for
  // collision detection, archived entries MUST be visible. Otherwise
  // an entry kept under one domain for history would silently allow a
  // duplicate id under a different domain, and getEntryById would
  // throw DuplicateEntryIdError on every subsequent lookup. Surface
  // the collision at write time when it is still cheap to fix.
  const wiki = makeWiki();
  try {
    const r1 = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "ghost",
      data: { ...validData("ghost"), status: "archived" },
      body: "Old.\n",
    }, happyDeps());
    assert.equal(r1.ok, true, `seed write should succeed: ${r1.error || ""}`);
    const r2 = writeEntry({
      wikiRoot: wiki,
      domain: "incidents",
      slug: "ghost",
      data: validData("ghost"),
      body: "New.\n",
    }, happyDeps());
    assert.equal(r2.ok, false, "should refuse duplicate against archived entry");
    assert.equal(r2.step, 0);
    assert.match(r2.error, /already exists/);
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
    let reconcileOpts = null;
    const r = writeEntry({
      wikiRoot: wiki,
      domain: "patterns",
      slug: "pr-iteration-bot-id",
      data: validData(),
      body: "Body.\n",
    }, {
      runSkillLlmWiki: () => ({ ok: true }),
      runIndexRebuild: (_root, _leaf, opts) => {
        calls += 1;
        if (calls === 1) return { ok: false, error: "rebuild crashed" };
        // Second call is the reconcile. Capture the on-disk state AND
        // the opts so we can assert (a) the leaf is GONE before
        // reconcile runs, and (b) the reconcile passes fullTree:true
        // so the runner skips the scoped attempt and goes straight to
        // a full-tree rebuild against the live (post-rollback) tree.
        leafExistsAtReconcile = existsSync(path);
        reconcileOpts = opts;
        return { ok: true, scoped: false };
      },
      enqueueFrontierReindex: () => ({ ok: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.step, 3);
    assert.equal(calls, 2, "reconcile rebuild must run after rollback");
    assert.equal(leafExistsAtReconcile, false, "leaf must be deleted BEFORE reconcile rebuild runs");
    assert.deepEqual(reconcileOpts, { fullTree: true }, "reconcile must request fullTree to skip scoped attempt");
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
