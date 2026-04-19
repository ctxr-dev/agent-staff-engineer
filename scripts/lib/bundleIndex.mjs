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
    const target = m[1];
    if (/^https?:\/\//.test(target)) continue;
    if (target.startsWith("mailto:")) continue;
    // Reject anything that escapes the bundle root. The validator
    // later calls readFile(resolve(BUNDLE_ROOT, target)), and without
    // this filter an absolute path ("/etc/passwd") or a parent-traversal
    // ("../../host-file") would be read off the filesystem, making CI
    // state depend on host layout. Accept only paths that stay inside
    // the bundle: no leading "/", no ".." segment. This is a defense-in-
    // depth filter; the validator still re-checks via readFile exist.
    if (target.startsWith("/")) continue;
    const segments = target.split("/");
    if (segments.some((s) => s === "..")) continue;
    out.add(target);
  }
  return out;
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
