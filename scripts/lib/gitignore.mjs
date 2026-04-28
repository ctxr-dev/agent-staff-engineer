// lib/gitignore.mjs
// Append one or more entries to a project's .gitignore, idempotently.
// Extracted from install.mjs so it is unit-testable.
//
// Two input shapes:
//   * bare string: legacy form, treated as a DIRECTORY pattern. Written
//     in canonical form `/<path>/` (anchored to repo root, trailing
//     slash so git matches the directory and its contents).
//   * `{ pattern, type: "file" | "dir" }`: explicit. `type: "file"`
//     emits `/<path>` with NO trailing slash so git matches the file.
//     `type: "dir"` matches the legacy bare-string behaviour.
//
// Idempotency:
//   - "Already listed" is determined by isListed(). For BARE-STRING
//     callers (the legacy form), match is loose: any line whose
//     normalised path equals the target counts, regardless of
//     trailing slash. So `/path/` and `/path` both shadow a
//     bare-string `path` request — preserving the historical
//     byte-stable behaviour for existing call sites.
//   - For OBJECT-FORM callers (`{ pattern, type }`), match is
//     STRICT: the existing line must ALSO match the requested
//     kind. A stale `/path/` (dir form) does NOT block a fresh
//     `{ pattern: "path", type: "file" }` request, and the two
//     forms can coexist on disk. This avoids the failure mode
//     where a stale dir-form line for a regenerable file path
//     (e.g. `.claude/state/knowledge-index.db/` left behind by an
//     older installer) silently masks the corrected file-form
//     ignore and leaves the file unignored. Callers that need to
//     switch a path between forms can simply add the typed entry;
//     ops can then prune the stale line by hand if they care.
//
// The installer typically adds two patterns for the `.development/` folder:
// `.development/local/` (per-user artefacts) and `.development/cache/` (regen
// scratch). The `.development/shared/` subtree is committed and deliberately
// NOT ignored.

import { join } from "node:path";
import { atomicWriteText, readTextOrNull } from "./fsx.mjs";

/**
 * Ensure every entry in the list is listed in the target's
 * `.gitignore`. Returns `{ path, added }` where `added` is the list
 * of patterns actually appended (empty when all were already listed).
 *
 * @typedef {string | { pattern: string, type?: "file" | "dir" }} GitignoreEntry
 *
 * @param {string} targetDir absolute path of the target project root
 * @param {GitignoreEntry | GitignoreEntry[]} relativePaths
 *   one or more repo-relative paths. Each entry is either a bare
 *   string (legacy form, treated as a directory pattern using the
 *   loose dedup) OR `{ pattern, type: "file" | "dir" }` (typed form
 *   using strict dedup; default is "dir" when omitted). An object
 *   without `type` is accepted but behaves identically to a bare
 *   string for that path: legacy dedup, dir canonical form.
 */
export async function ensureGitignore(targetDir, relativePaths) {
  const list = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
  const gi = join(targetDir, ".gitignore");
  const originalRaw = await readTextOrNull(gi);
  let content = originalRaw ?? "";
  const added = [];

  for (const item of list) {
    // Each entry is either a bare string (legacy form, treated as a
    // directory pattern with trailing slash) OR an object
    // `{ pattern, type: "file" | "dir" }` so callers can ignore a
    // single regenerable file (e.g. .claude/state/knowledge-index.db)
    // without ending up with a directory-only pattern that does not
    // match the file. Default stays "dir" so existing call sites
    // (`.development/local`, `.development/cache`) keep their
    // original behaviour byte-for-byte.
    let rel;
    let type = "dir";
    // Tracks whether the caller explicitly opted into the typed
    // input shape. Bare-string callers stay on the legacy loose
    // dedup (any pre-existing line for the same path counts as a
    // match, regardless of whether it had a trailing slash).
    // Object-form callers get strict type-aware dedup so a stale
    // dir-form line cannot mask a fresh file-form request.
    let strictType = false;
    if (typeof item === "string") {
      rel = item;
    } else if (item && typeof item === "object" && typeof item.pattern === "string") {
      rel = item.pattern;
      if (item.type === "file" || item.type === "dir") {
        type = item.type;
        strictType = true;
      }
    } else {
      throw new Error(`ensureGitignore: entry must be a string or { pattern, type } object; got ${JSON.stringify(item)}`);
    }
    const normalised = normalisePattern(rel);
    if (!normalised) {
      throw new Error(`ensureGitignore: empty gitignore pattern after normalisation: "${rel}"`);
    }
    if (isListed(content, normalised, strictType ? type : null)) continue;
    const canonical = type === "file" ? `/${normalised}` : `/${normalised}/`;
    const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    content = `${content}${separator}${canonical}\n`;
    added.push(canonical);
  }

  if (added.length === 0) return { path: gi, added };
  await atomicWriteText(gi, content);
  return { path: gi, added };
}

/**
 * Normalise a pattern for canonical .gitignore form. Trims surrounding
 * whitespace, converts Windows-style `\\` separators to forward slashes
 * (gitignore patterns are slash-based regardless of host OS), then
 * strips leading and trailing slashes so ensureGitignore can re-add
 * them in the canonical anchored shape. Exported for tests.
 *
 * Examples:
 *   "  .development/local  "          -> ".development/local"
 *   ".claude\\state\\knowledge-index.db" -> ".claude/state/knowledge-index.db"
 *   "/.development/local/"            -> ".development/local"
 */
export function normalisePattern(p) {
  if (typeof p !== "string") return "";
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Does an existing .gitignore list this entry?
 *
 * @param {string} content        full .gitignore text
 * @param {string} normalisedTarget pattern with leading/trailing slashes stripped
 * @param {"file" | "dir"} [type]  when provided, ALSO require the existing
 *                                 line to match the requested type. A line
 *                                 ending with `/` is a directory pattern;
 *                                 without `/` is a file pattern. When `type`
 *                                 is omitted, any matching path counts
 *                                 (the legacy behaviour for back-compat).
 *
 * Type-awareness matters for the `{type: "file"}` callers: a stale
 * `/.claude/state/knowledge-index.db/` (dir form) line in the project's
 * .gitignore would otherwise mask a fresh `{type: "file"}` request and
 * leave the DB unignored. With the type check, the helper sees that
 * the existing line is a different KIND of pattern and appends the
 * correct file form alongside it.
 */
export function isListed(content, normalisedTarget, type = null) {
  return String(content)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .some((line) => {
      if (normalisePattern(line) !== normalisedTarget) return false;
      if (type == null) return true;
      const lineIsDir = line.endsWith("/");
      const wantDir = type === "dir";
      return lineIsDir === wantDir;
    });
}
