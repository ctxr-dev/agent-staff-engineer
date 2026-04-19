// lib/bundleIndex.mjs
// Shared helper used by both validate_bundle.mjs (check #12) and the
// tests/bundle-index.test.mjs. Keeps the link-extraction regex in ONE
// place so a future tweak (e.g. "also reject images", "handle escaped
// parens") updates prod + tests together without drift.

/**
 * Extract internal markdown link targets from a bundle-index.md-shaped
 * document. Rules:
 *   - `[text](path)` forms with a relative `path` are returned (bundle-
 *     relative targets).
 *   - External URLs (`http://`, `https://`), `mailto:`, and
 *     fragment-only (`#section`) targets are excluded.
 *   - `#anchor` suffixes are stripped from the returned value; the
 *     caller cares about file existence, not anchor validity.
 *   - Image references `![alt](path)` are EXCLUDED — this is a
 *     link/routing helper, not an asset check. An image in the bundle
 *     index would need its own separate check.
 *
 * Returns a `Set<string>` of bundle-relative paths with no `#anchor`.
 *
 * @param {string} text raw bundle-index.md contents
 */
export function extractIndexLinks(text) {
  if (typeof text !== "string") {
    throw new TypeError("extractIndexLinks: text must be a string");
  }
  // Negative lookbehind `(?<!!)` rejects `![alt](path)` image syntax
  // while still matching `[text](path)`. Without the lookbehind, an
  // image link would be treated as a routing entry and get orphan
  // credit silently satisfying the check without actually routing
  // the file to any reader.
  const LINK_RE = /(?<!!)\[[^\]]+\]\(([^)\s#][^)\s]*?)(#[^)\s]*)?\)/g;
  const out = new Set();
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    const raw = m[1];
    if (/^https?:\/\//.test(raw)) continue;
    if (raw.startsWith("mailto:")) continue;
    const canonical = canonicalizeTarget(raw);
    if (canonical === null) continue;
    out.add(canonical);
  }
  return out;
}

/**
 * Normalise a raw link target to the canonical bundle-relative form
 * the orphan check compares against (`skills/foo/SKILL.md`), OR return
 * `null` if the target cannot safely live inside the bundle.
 *
 * Rejections (returns null):
 *   - leading "/" (POSIX absolute)
 *   - Windows drive prefix ("C:\..." or "C:/...")
 *   - any ".." segment after separator unification
 *   - any path that, after normalisation, is empty
 *
 * Transformations:
 *   - "\" separators (Windows-style) unified to "/"
 *   - leading "./" stripped (so `./foo.md` and `foo.md` both canonicalise
 *     to `foo.md`, matching the orphan check's canonical form)
 *
 * The canonicalisation is cheap and happens at parse time, not at
 * validate-match time, so downstream callers can use simple
 * `Set.has(rel)` lookups without per-call normalisation.
 */
function canonicalizeTarget(raw) {
  if (raw.startsWith("/")) return null;                    // POSIX absolute
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return null;            // Windows drive
  let t = raw.replace(/\\/g, "/");                         // unify separators
  while (t.startsWith("./")) t = t.slice(2);               // strip leading ./
  if (t.length === 0) return null;
  const segments = t.split("/");
  if (segments.some((s) => s === "..")) return null;       // traversal
  return t;
}

/**
 * The surfaces the bundle-index MUST fully cover. The orphan check
 * walks each root, applies the filter, and asserts every matching
 * file appears at least once as a link target in bundle-index.md.
 *
 * Sibling non-SKILL docs under `skills/*` (e.g. `pr-iteration/runbook.md`)
 * are intentionally NOT required — the index author decides whether a
 * sibling is part of the public surface.
 */
export const REQUIRED_INDEX_SURFACES = Object.freeze([
  { dir: "skills", nameFilter: (rel) => rel.endsWith("/SKILL.md") },
  { dir: "rules", nameFilter: (rel) => rel.endsWith(".md") },
  { dir: "templates", nameFilter: (rel) => rel.endsWith(".md") },
  { dir: "memory-seeds", nameFilter: (rel) => rel.endsWith(".md") },
]);
