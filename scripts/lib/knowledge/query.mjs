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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseEntry } from "./frontmatter.mjs";

// Cache invalidation. The knowledge-dir mtime alone isn't enough:
//   - directory mtime changes when entries are added / removed at the
//     ROOT, but a rename or move inside a nested subdirectory can
//     leave the root mtime intact;
//   - mtime never changes for an in-place edit either.
// To catch all three (add/remove, in-place edit, nested rename) we
// cache a fingerprint composed of:
//   - the root dir mtime (catches add/remove at the top level cheaply)
//   - the leaf count
//   - max(leaf.mtimeMs) — catches in-place edits
//   - sum(leaf.size) — defence-in-depth against same-mtime edits
//   - sha256 of the sorted-leaf-path list — catches rename / move in
//     any subdirectory without statSync-ing every parent dir.
// Any drift across the fingerprint invalidates the cache. The cache
// is keyed by the absolute knowledge-dir path passed in (NOT a
// realpath resolution); two callers passing different symlink paths
// to the same underlying tree get distinct cache entries.
const _treeCache = new Map(); // dir absolute path -> { fingerprint, entries }

/**
 * Locate the canonical knowledge directory under a wiki root.
 *
 * @param {string} wikiRoot  absolute path to the configured wiki root (typically `wiki.roots.shared`)
 * @returns {string} absolute path to <wikiRoot>/knowledge
 */
export function knowledgeDir(wikiRoot) {
  return resolve(wikiRoot, "knowledge");
}

/**
 * Enumerate every leaf entry under <wikiRoot>/knowledge.
 *
 * Pure-ish: walks the filesystem, but its result depends only on the
 * tree state at call time. The in-process cache is keyed by the resolved
 * `<wikiRoot>/knowledge` path and invalidated by a multi-field tree
 * fingerprint (dir mtime + leaf count + max leaf mtime + total size +
 * sha256 of sorted leaf paths) so adds, removes, in-place edits, and
 * nested renames all bust it without manual invalidation.
 *
 * Returns an array of { id, path, data, body } objects sorted by id.
 *
 * @param {string} wikiRoot
 * @param {{ noCache?: boolean }} [opts]
 */
export function enumerateEntries(wikiRoot, opts = {}) {
  const dir = knowledgeDir(wikiRoot);
  // Single TOCTOU-safe stat: if the dir is absent, was deleted, or we
  // can't read it, treat the wiki as empty. The previous existsSync()
  // pre-check could race with a concurrent rm -r between the test and
  // the statSync below; one statSync inside try/catch closes the gap.
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    return [];
  }
  if (!dirStat.isDirectory()) return [];
  const cacheKey = dir;

  // Walk the tree once; collect every leaf's (path, stat) so we can
  // build the cache fingerprint. Even on a hot cache we still pay
  // for the readdir + per-leaf statSync pass (the fingerprint has
  // to come from somewhere); what the cache saves is the per-leaf
  // readFileSync + YAML parse + ajv-implicit-shape check below,
  // which is ~10-100x more expensive than a single stat call.
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
  // dirStat was already obtained above (one stat, no TOCTOU).
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
  // Combines dir mtime + (count, max-mtime, total-size, path-set hash)
  // over leaves. O(number of leaves) — cheap relative to YAML parse.
  // Catches:
  //   * add / remove at the root (dirMtimeMs)
  //   * in-place edits (max-mtime + total-size)
  //   * rename / move in any subdirectory (path-set hash)
  let maxMtime = 0;
  let totalSize = 0;
  for (const f of leafFiles) {
    if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
    totalSize += f.size;
  }
  // Sort by path so the hash is stable across walk ordering. sha256 is
  // overkill for a non-adversarial fingerprint but it's a one-shot
  // expense (one hash per cache miss) and the rest of the bundle
  // already uses createHash for similar fingerprints.
  const pathHash = createHash("sha256");
  const sortedPaths = leafFiles.map((f) => f.path).sort();
  for (const p of sortedPaths) {
    pathHash.update(p);
    pathHash.update("\u001f");
  }
  return `${dirMtimeMs}|${leafFiles.length}|${maxMtime}|${totalSize}|${pathHash.digest("hex")}`;
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
 * Find a single entry by id. Returns null if not found. Throws if more
 * than one entry shares the id: the schema treats `data.id` as the
 * lookup key (the on-disk path encodes the domain, the id does not),
 * so duplicates would let getEntryById return an arbitrary winner and
 * silently mis-route every link that resolves through this function.
 * The duplicate state is repairable damage — writeEntry rejects new
 * writes that would create one, but a hand-edited tree could still
 * land here. Surfacing the duplicate is strictly better than picking
 * a winner.
 *
 * @param {string} wikiRoot
 * @param {string} id
 * @throws {DuplicateEntryIdError} when the wiki contains more than one
 *   entry with the supplied id (typically the result of a manual rename
 *   or a cross-domain copy)
 */
export function getEntryById(wikiRoot, id) {
  // Pass includeArchived: true so an exact-id lookup ALWAYS resolves
  // the entry even when it is status:"archived". The default query
  // semantics (archived excluded) make sense for routing, but for an
  // explicit by-id lookup the user is asking "where does this id
  // live?" and an unexpected null would mask a real archived entry.
  // Including archived here is also load-bearing for duplicate-id
  // detection: a duplicate where one copy was archived would
  // otherwise slip past unnoticed.
  const matches = query(wikiRoot, { id, includeArchived: true });
  if (matches.length > 1) {
    throw new DuplicateEntryIdError(id, matches.map((m) => m.path));
  }
  return matches[0] ?? null;
}

/**
 * Thrown by getEntryById when the wiki contains multiple entries with
 * the same id. The `paths` field lists every offending leaf so a human
 * can resolve the conflict (rename one, delete one, or extend the
 * schema to support domain-qualified ids).
 */
export class DuplicateEntryIdError extends Error {
  constructor(id, paths) {
    super(
      `knowledge: duplicate entry id ${JSON.stringify(id)} found at ${paths.length} paths: ${paths.join(", ")}. ` +
        "Rename one of the entries (or delete the stale copy) so id-based lookups resolve unambiguously.",
    );
    this.name = "DuplicateEntryIdError";
    this.id = id;
    this.paths = paths;
  }
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
