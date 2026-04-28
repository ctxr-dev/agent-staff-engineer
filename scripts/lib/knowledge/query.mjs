// scripts/lib/knowledge/query.mjs
//
// Read-side API for the canonical knowledge store. Walks
// <wikiRoot>/knowledge/ once per call, parses the frontmatter of every
// leaf .md, and returns the matching entries. The full SQLite frontier
// (Tier 2 in the issue's architecture) is a follow-up; until then the
// walk + in-process cache pattern keeps the read latency proportional
// to the tree's leaf count, which is small in practice and acceptable
// for the slice this PR ships.
//
// Filtering shape mirrors what consumer skills will need on day one:
// by id, by kind, by entity, by parent, and by status. Returning an
// array of entries (not a streaming iterator) is intentional — callers
// uniformly want the full result set materialised so they can sort or
// score it themselves.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEntry } from "./frontmatter.mjs";

// Cache invalidation. The knowledge-dir mtime alone isn't enough:
// directory mtime changes when entries are added / removed / renamed,
// but NOT when an existing leaf's contents change in place. To detect
// in-place edits without re-walking + re-parsing the tree on every
// call, we cache a fingerprint that combines:
//   - the dir mtime (cheap; catches add / remove / rename)
//   - the running max(leaf.mtimeMs) + sum(leaf.size) across all
//     `.md` files in the tree (catches in-place edits via one
//     statSync per leaf, an order of magnitude cheaper than parsing
//     the YAML frontmatter).
// Any drift across the fingerprint invalidates the cache.
const _treeCache = new Map(); // realRoot -> { fingerprint, entries }

/**
 * Locate the canonical knowledge directory under a wiki root.
 *
 * @param {string} wikiRoot  absolute path to <paths.wiki>
 * @returns {string} absolute path to <wikiRoot>/knowledge
 */
export function knowledgeDir(wikiRoot) {
  return resolve(wikiRoot, "knowledge");
}

/**
 * Enumerate every leaf entry under <wikiRoot>/knowledge.
 *
 * Pure-ish: walks the filesystem, but its result depends only on the
 * tree state at call time. The in-process cache (keyed by realpath) is
 * invalidated when the directory's mtime changes, so post-write callers
 * see fresh results without manual invalidation.
 *
 * Returns an array of { id, path, data, body } objects sorted by id.
 *
 * @param {string} wikiRoot
 * @param {{ noCache?: boolean }} [opts]
 */
export function enumerateEntries(wikiRoot, opts = {}) {
  const dir = knowledgeDir(wikiRoot);
  if (!existsSync(dir)) return [];
  const cacheKey = dir;

  // Walk the tree once; collect every leaf's (path, stat) so we can
  // cheaply build the cache fingerprint AND avoid re-walking when the
  // cache is hot. The fingerprint stat-only pass is one statSync per
  // leaf — substantially cheaper than the readFileSync + YAML parse
  // we'd otherwise repeat on a stale cache.
  const leafFiles = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let names;
    try {
      names = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      if (ent.name.startsWith(".")) continue;
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.name.endsWith(".md")) continue;
      if (ent.name === "index.md") continue;
      try {
        const st = statSync(full);
        leafFiles.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        continue;
      }
    }
  }

  // Fingerprint the tree state. Any add / remove / rename changes the
  // count or path order; any in-place edit changes max-mtime or sum-size.
  const dirStat = statSync(dir);
  const fingerprint = computeTreeFingerprint(dirStat.mtimeMs, leafFiles);

  if (!opts.noCache) {
    const cached = _treeCache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprint) return cached.entries;
  }

  const out = [];
  for (const leaf of leafFiles) {
    let text;
    try {
      text = readFileSync(leaf.path, "utf8");
    } catch {
      continue;
    }
    let data, body;
    try {
      const parsed = parseEntry(text);
      data = parsed.data;
      body = parsed.content;
    } catch {
      continue;
    }
    if (!data || typeof data.id !== "string") continue;
    out.push({ id: data.id, path: leaf.path, data, body });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  if (!opts.noCache) {
    _treeCache.set(cacheKey, { fingerprint, entries: out });
  }
  return out;
}

function computeTreeFingerprint(dirMtimeMs, leafFiles) {
  // Concatenate dir mtime + (count, max-mtime, total-size) over leaves.
  // This is `O(number of leaves)` — cheap relative to YAML parse — and
  // catches add / remove / rename via dirMtimeMs and count, plus
  // in-place edits via max-mtime + total-size.
  let maxMtime = 0;
  let totalSize = 0;
  for (const f of leafFiles) {
    if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
    totalSize += f.size;
  }
  return `${dirMtimeMs}|${leafFiles.length}|${maxMtime}|${totalSize}`;
}

/**
 * Filter entries matching a query. All filter fields are optional;
 * absent fields don't constrain. Filters AND together: an entry must
 * match every supplied field.
 *
 * @param {string} wikiRoot
 * @param {object} [filter]
 * @param {string} [filter.id]            exact match on id
 * @param {string|string[]} [filter.kind] one or more kinds
 * @param {string} [filter.entity]        substring match against entities[]
 * @param {string} [filter.parent]        match if `parent` is in parents[]
 * @param {string|string[]} [filter.status] one or more statuses
 * @param {boolean} [filter.includeArchived] when false (default), status==="archived" is excluded unless explicitly requested
 * @returns {{id:string,path:string,data:object,body:string}[]}
 */
export function query(wikiRoot, filter = {}) {
  const all = enumerateEntries(wikiRoot);
  const includeArchived = !!filter.includeArchived;
  const kinds = arr(filter.kind);
  const statuses = arr(filter.status);
  const out = [];
  for (const entry of all) {
    if (filter.id && entry.id !== filter.id) continue;
    if (kinds.length > 0 && !kinds.includes(entry.data.kind)) continue;
    if (
      filter.entity &&
      !(Array.isArray(entry.data.entities) && entry.data.entities.some((e) => typeof e === "string" && e.includes(filter.entity)))
    ) {
      continue;
    }
    if (filter.parent && !(Array.isArray(entry.data.parents) && entry.data.parents.includes(filter.parent))) {
      continue;
    }
    if (statuses.length > 0) {
      if (!statuses.includes(entry.data.status)) continue;
    } else if (!includeArchived && entry.data.status === "archived") {
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Find a single entry by id. Returns null if not found.
 *
 * @param {string} wikiRoot
 * @param {string} id
 */
export function getEntryById(wikiRoot, id) {
  const matches = query(wikiRoot, { id });
  return matches[0] ?? null;
}

// Test-only: clear the in-process cache so consecutive tests don't see
// each other's writes when they share a wikiRoot under the same mtime.
export function _clearCache() {
  _treeCache.clear();
}

function arr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

// Re-export so callers can write `import { dirname } from "./query.mjs"`
// in scripts that compose the read + write helpers.
export { dirname };
