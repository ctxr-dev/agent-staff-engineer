// lib/gitignore.mjs
// Append one or more entries to a project's .gitignore, idempotently.
// Extracted from install.mjs so it is unit-testable.
//
// The installer typically adds two patterns for the `.development/` folder:
// `.development/local/` (per-user artefacts) and `.development/cache/` (regen
// scratch). The `.development/shared/` subtree is committed and deliberately
// NOT ignored. Both facts live together in this helper so the installer can
// describe the full list in one call.
//
// Matching rules:
//   1. The helper writes each entry in its canonical form (`/<path>/`) so git
//      treats it as an anchored-to-repo-root folder pattern.
//   2. It considers an entry "already listed" when any existing line matches
//      the same normalised path — any combination of leading slash,
//      trailing slash, or trailing `# comment` counts as a match, so we do
//      not accidentally duplicate user-written variants.

import { join } from "node:path";
import { atomicWriteText, readTextOrNull } from "./fsx.mjs";

/**
 * Ensure every `relativePath` in the list is listed in the target's
 * `.gitignore`. Returns `{ path, added }` where `added` is the list of
 * patterns actually appended (empty when all were already listed).
 *
 * @param {string} targetDir absolute path of the target project root
 * @param {string | string[]} relativePaths one or more repo-relative paths (e.g. `.development/local`)
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
    if (typeof item === "string") {
      rel = item;
    } else if (item && typeof item === "object" && typeof item.pattern === "string") {
      rel = item.pattern;
      if (item.type === "file" || item.type === "dir") type = item.type;
    } else {
      throw new Error(`ensureGitignore: entry must be a string or { pattern, type } object; got ${JSON.stringify(item)}`);
    }
    const normalised = normalisePattern(rel);
    if (!normalised) {
      throw new Error(`ensureGitignore: empty gitignore pattern after normalisation: "${rel}"`);
    }
    if (isListed(content, normalised)) continue;
    const canonical = type === "file" ? `/${normalised}` : `/${normalised}/`;
    const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    content = `${content}${separator}${canonical}\n`;
    added.push(canonical);
  }

  if (added.length === 0) return { path: gi, added };
  await atomicWriteText(gi, content);
  return { path: gi, added };
}

/** Strip leading and trailing slashes from a pattern. Exported for tests. */
export function normalisePattern(p) {
  if (typeof p !== "string") return "";
  return p.replace(/^\/+|\/+$/g, "");
}

/** Does an existing .gitignore list this entry (ignoring comments, whitespace, slashes)? */
export function isListed(content, normalisedTarget) {
  return String(content)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .some((line) => normalisePattern(line) === normalisedTarget);
}
