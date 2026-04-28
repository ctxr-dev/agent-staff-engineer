// scripts/lib/claude-md/seed.mjs
//
// Idempotent seeder for the compound-learning registry section inside a
// project's CLAUDE.md. Owns ONE marked block; everything outside the
// markers is preserved byte-for-byte.
//
// On fresh install (CLAUDE.md absent or no markers): writes a stub with
// "Project context", "Compound learning -> Patterns that worked / failed /
// Codebase quirks" headings.
//
// On existing install (markers already present): leaves the block alone.
// The intent is "seed once"; growing the registry happens through
// append-entry.mjs, which edits between the markers.
//
// The marker pair is distinct from the install.mjs CLAUDE.md managed-block
// markers so the two can coexist without colliding. Authoring guidance:
// see design/claude-md-authoring.md.

import { readTextOrNull, atomicWriteText } from "../fsx.mjs";

export const REGISTRY_BEGIN_MARKER =
  "<!-- agent-staff-engineer:begin compound-learning registry (managed by claude-md/seed.mjs and append-entry.mjs; edits inside are preserved across re-seeds) -->";
export const REGISTRY_END_MARKER =
  "<!-- agent-staff-engineer:end compound-learning registry -->";

// Stub body written between the markers on the very first seed. Once any
// content lives between them (a real entry from append-entry, or a
// human-authored note), seedRegistry leaves it alone.
const STUB_BODY = [
  "## Project context",
  "",
  "[placeholder: one paragraph, ~ 200 words; fill in after the first few",
  "agent runs surface concrete examples. See `design/claude-md-authoring.md`",
  "for what belongs here vs in the wiki archive.]",
  "",
  "## Compound learning",
  "",
  "### Patterns that worked",
  "",
  "<!-- Append entries here via scripts/lib/claude-md/append-entry.mjs.",
  "     Shape: see templates/claude-md/compound-learning.md. -->",
  "",
  "### Patterns that failed",
  "",
  "<!-- Same shape; always include a Remediation pointer so future agents",
  "     do not retry the same dead-end. -->",
  "",
  "### Codebase quirks",
  "",
  "<!-- Append via scripts/lib/claude-md/append-entry.mjs --section quirk.",
  "     Each quirk renders as a single bullet line containing the title,",
  "     the remediation pointer, and the last-verified date. -->",
  "",
].join("\n");

/**
 * Seed (or no-op) the compound-learning registry inside the supplied
 * CLAUDE.md content. Pure: returns the new content; does not touch disk.
 *
 * @param {string | null} existing - current CLAUDE.md content, or null when absent
 * @returns {{ content: string, changed: boolean }}
 */
export function seedRegistryInContent(existing) {
  // CLAUDE.md absent: write a minimal file with just the registry block.
  if (existing == null || existing === "") {
    return {
      content: renderBlock(STUB_BODY) + "\n",
      changed: true,
    };
  }

  // CLAUDE.md exists; check for the marker pair. Match-once semantics: if
  // a user accidentally pasted a marker as prose, the FIRST begin / LAST
  // end pair is treated as authoritative and the inside is preserved.
  const beginIdx = existing.indexOf(REGISTRY_BEGIN_MARKER);
  const endIdx = existing.lastIndexOf(REGISTRY_END_MARKER);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Already seeded; never overwrite. Future entries flow through
    // append-entry.mjs.
    return { content: existing, changed: false };
  }

  // Markers absent: append the block at the end with a blank-line
  // separator so the user's existing prose stays intact.
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return {
    content: existing + sep + renderBlock(STUB_BODY) + "\n",
    changed: true,
  };
}

/**
 * Disk-side wrapper around seedRegistryInContent. Uses the bundle's
 * atomicWriteText helper (write-to-temp + rename) so a partially-
 * written CLAUDE.md never lands on disk; this matches the convention
 * established by scripts/install.mjs and the rest of the writer surface.
 *
 * @param {string} claudeMdPath - absolute path to the project's CLAUDE.md
 * @returns {Promise<{ path: string, changed: boolean }>}
 */
export async function seedRegistryAtPath(claudeMdPath) {
  const existing = await readTextOrNull(claudeMdPath);
  const { content, changed } = seedRegistryInContent(existing);
  if (changed) await atomicWriteText(claudeMdPath, content);
  return { path: claudeMdPath, changed };
}

function renderBlock(body) {
  // The trailing newline on `body` is enforced so the closing marker is
  // always on its own line, never glued to the last entry.
  const trimmed = body.endsWith("\n") ? body : body + "\n";
  return `${REGISTRY_BEGIN_MARKER}\n${trimmed}${REGISTRY_END_MARKER}`;
}
