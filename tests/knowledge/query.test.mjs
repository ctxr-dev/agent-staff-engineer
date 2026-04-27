// Tests for scripts/lib/knowledge/query.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { enumerateEntries, query, getEntryById, _clearCache } from "../../scripts/lib/knowledge/query.mjs";
import { serialiseEntry } from "../../scripts/lib/knowledge/frontmatter.mjs";

function makeWiki() {
  return mkdtempSync(join(tmpdir(), "knowledge-query-"));
}

function seed(wikiRoot, domain, slug, overrides = {}) {
  const data = {
    id: slug,
    type: "leaf",
    depth_role: "leaf",
    focus: `Focus for ${slug}`,
    covers: [slug],
    parents: [domain],
    kind: "pattern",
    first_seen: "2026-04-10",
    last_verified: "2026-04-28",
    source: "test",
    status: "active",
    ...overrides,
  };
  const dir = join(wikiRoot, "knowledge", domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), serialiseEntry(data, `Body for ${slug}.\n`));
  return data;
}

test("enumerateEntries: returns every leaf, sorted by id", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "alpha-pattern");
    seed(wiki, "patterns", "zeta-pattern");
    seed(wiki, "incidents", "mid-incident");
    _clearCache();
    const entries = enumerateEntries(wiki);
    assert.deepEqual(entries.map((e) => e.id), ["alpha-pattern", "mid-incident", "zeta-pattern"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("enumerateEntries: index.md and dotfiles are excluded", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "real-leaf");
    const dir = join(wiki, "knowledge", "patterns");
    writeFileSync(join(dir, "index.md"), "# index file");
    writeFileSync(join(dir, ".hidden.md"), "hidden");
    _clearCache();
    const entries = enumerateEntries(wiki, { noCache: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "real-leaf");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("query: filters by kind", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "p1", { kind: "pattern" });
    seed(wiki, "incidents", "i1", { kind: "incident" });
    seed(wiki, "decisions", "d1", { kind: "decision" });
    _clearCache();
    const r = query(wiki, { kind: ["pattern", "decision"] });
    assert.deepEqual(r.map((e) => e.id).sort(), ["d1", "p1"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("query: filters by entity (substring)", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "p1", { entities: ["scripts/lib/pr-iteration/tick.mjs"] });
    seed(wiki, "patterns", "p2", { entities: ["rules/no-dashes.md"] });
    _clearCache();
    const r = query(wiki, { entity: "pr-iteration" });
    assert.deepEqual(r.map((e) => e.id), ["p1"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("query: filters by parent (membership)", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "p1", { parents: ["patterns", "shared"] });
    seed(wiki, "patterns", "p2", { parents: ["patterns"] });
    _clearCache();
    const r = query(wiki, { parent: "shared" });
    assert.deepEqual(r.map((e) => e.id), ["p1"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("query: archived entries excluded by default, included on opt-in", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "active1", { status: "active" });
    seed(wiki, "patterns", "old1", { status: "archived" });
    _clearCache();
    const def = query(wiki);
    assert.deepEqual(def.map((e) => e.id), ["active1"]);
    const all = query(wiki, { includeArchived: true });
    assert.deepEqual(all.map((e) => e.id).sort(), ["active1", "old1"]);
    const explicit = query(wiki, { status: "archived" });
    assert.deepEqual(explicit.map((e) => e.id), ["old1"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("getEntryById: returns matching entry or null", () => {
  const wiki = makeWiki();
  try {
    seed(wiki, "patterns", "needle");
    _clearCache();
    const hit = getEntryById(wiki, "needle");
    assert.ok(hit && hit.id === "needle");
    const miss = getEntryById(wiki, "haystack");
    assert.equal(miss, null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("query: missing knowledge/ tree returns empty array (not throw)", () => {
  const wiki = makeWiki();
  try {
    _clearCache();
    assert.deepEqual(enumerateEntries(wiki), []);
    assert.deepEqual(query(wiki, { id: "x" }), []);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
