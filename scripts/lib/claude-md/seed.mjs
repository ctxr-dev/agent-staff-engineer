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

  // CLAUDE.md exists; check for the marker pair. Marker matches are
  // line-boundary anchored so a marker quoted inside a code fence or
  // mid-line prose does not get treated as authoritative. Match-once
  // semantics: FIRST begin / LAST end pair wins.
  const located = findRegistryMarkers(existing);
  if (located) {
    // Already seeded; never overwrite. Future entries flow through
    // append-entry.mjs.
    return { content: existing, changed: false };
  }

  // Markers absent: append the block at the end. Preserve the file's
  // existing line-ending style so a CRLF checkout doesn't end up with
  // a mixed-EOL tail (the user's prose stays CRLF; the appended block
  // matches). Match append-entry.mjs's detectEol contract.
  const eol = detectEol(existing);
  const block = renderBlock(STUB_BODY) + "\n";
  const reEoled = eol === "\r\n" ? block.replace(/\r?\n/g, "\r\n") : block;
  let sep;
  if (existing.endsWith(eol + eol)) sep = "";
  else if (existing.endsWith(eol)) sep = eol;
  else sep = eol + eol;
  return {
    content: existing + sep + reEoled,
    changed: true,
  };
}

function detectEol(text) {
  // Use the first newline observed; the file is presumed self-consistent.
  if (typeof text !== "string" || text.length === 0) return "\n";
  const idx = text.indexOf("\n");
  if (idx === -1) return "\n";
  return idx > 0 && text[idx - 1] === "\r" ? "\r\n" : "\n";
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

/**
 * Error thrown when CLAUDE.md contains a malformed registry marker pair
 * (exactly one of begin/end present, or end appearing before begin).
 * Both cases mean the file's registry state is unusable: silently
 * appending a fresh block would leave a dangling sibling marker pair
 * and produce two separate registry blocks. Callers (install.mjs, the
 * append-entry CLI) catch this and surface a clear diagnostic so the
 * user can fix the file by hand before re-running.
 */
export class MalformedRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "MalformedRegistryError";
  }
}

/**
 * Locate the registry markers with line-boundary anchoring. A marker is
 * considered authoritative only when it starts at the beginning of a line
 * (preceded by `\n`, start-of-string, or a UTF-8 BOM at offset 0) AND
 * terminates at the end of a line (followed by `\n` / `\r` or end-of-
 * string). Returns `null` when neither marker is present. Throws
 * MalformedRegistryError when exactly one marker is found, or when the
 * end marker appears before the begin marker.
 *
 * Known limitation: a marker copy that sits at column 0 inside a fenced
 * code block (e.g. a CLAUDE.md author who pasted the marker text into a
 * ```...``` example without indenting it) WILL satisfy the line-anchor
 * check and be treated as authoritative. This is the same compromise
 * inject.mjs makes for the wider managed-block markers; the marker
 * strings are deliberately verbose and namespaced so the chance of a
 * benign collision is vanishingly low. Documented here rather than
 * worked around because parsing markdown code fences in this seeder
 * adds risk out of proportion to the benefit.
 *
 * @param {string} content
 * @returns {{ begin: number, end: number } | null}
 */
export function findRegistryMarkers(content) {
  if (typeof content !== "string") return null;
  const begin = findLineAnchored(content, REGISTRY_BEGIN_MARKER, false);
  const end = findLineAnchored(content, REGISTRY_END_MARKER, true);
  if (begin === -1 && end === -1) return null;
  if (begin === -1 || end === -1) {
    throw new MalformedRegistryError(
      `CLAUDE.md contains exactly one of the registry markers (begin=${begin !== -1}, end=${end !== -1}). ` +
        "Restore the missing marker or remove the orphan, then re-run.",
    );
  }
  if (end <= begin) {
    throw new MalformedRegistryError(
      `CLAUDE.md contains the registry END marker before the BEGIN marker (begin=${begin}, end=${end}). ` +
        "Reorder the marker pair, then re-run.",
    );
  }
  return { begin, end };
}

function findLineAnchored(haystack, needle, fromEnd) {
  let pos = fromEnd ? haystack.lastIndexOf(needle) : haystack.indexOf(needle);
  while (pos !== -1) {
    // Valid line-start boundaries: start-of-string (pos === 0), the
    // character right after a `\n`, OR position 1 when the file opens
    // with a UTF-8 BOM at offset 0. Without the BOM allowance, a
    // CLAUDE.md saved by a Windows editor that auto-prefixes \uFEFF
    // would push the marker to index 1 and the seeder would treat the
    // file as if no markers were present, doubling the block on every
    // re-seed. inject.mjs::findLineContaining handles BOMs the same
    // way; this helper mirrors that contract.
    const prev = haystack[pos - 1];
    const startOk =
      pos === 0 ||
      prev === "\n" ||
      (pos === 1 && haystack.charCodeAt(0) === 0xfeff);
    const endPos = pos + needle.length;
    const endOk =
      endPos === haystack.length ||
      haystack[endPos] === "\n" ||
      haystack[endPos] === "\r";
    if (startOk && endOk) return pos;
    pos = fromEnd
      ? haystack.lastIndexOf(needle, pos - 1)
      : haystack.indexOf(needle, pos + 1);
  }
  return -1;
}

/**
 * True when CLAUDE.md contains the registry markers AND the body between
 * them matches the seed stub byte-for-byte (ignoring CRLF/LF variation
 * and surrounding whitespace). Used by uninstall to decide whether the
 * registry block is safe to strip: a pristine block was never edited by
 * the user, so removing it is non-destructive; any deviation means the
 * user (or an entry from append-entry.mjs) added content worth keeping.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isPristineRegistryBlock(content) {
  // Pristine-vs-edited is consulted by uninstall as a strip safety
  // gate: when in doubt (markers absent, malformed, body diverges
  // even slightly), return false so the block is preserved. Any throw
  // from findRegistryMarkers (a malformed marker pair) is swallowed
  // here for the same reason — uninstall is not the right surface to
  // raise that error; install / append-entry will surface it on the
  // next mutating run.
  let located;
  try {
    located = findRegistryMarkers(content);
  } catch {
    return false;
  }
  if (!located) return false;
  const innerStart = located.begin + REGISTRY_BEGIN_MARKER.length;
  const body = content.slice(innerStart, located.end);
  return normaliseBlockBody(body) === normaliseBlockBody(STUB_BODY);
}

function normaliseBlockBody(s) {
  return String(s).replace(/\r\n/g, "\n").trim();
}
