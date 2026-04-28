// lib/inject.mjs
// Insert or refresh a managed block inside a (possibly pre-existing) markdown
// file without disturbing the user's own content.
//
// The pattern used here is the standard "begin/end markers" approach that many
// well-behaved installers use (think: `.bashrc` additions, editor configs,
// awscli credentials, etc.). The installer owns the content BETWEEN two
// exact-match lines and leaves every other byte untouched:
//
//     <stuff the user wrote>
//     <!-- agent-staff-engineer:begin managed block ... -->
//     <agent-managed content; regenerated on every --update>
//     <!-- agent-staff-engineer:end managed block ... -->
//     <more stuff the user wrote>
//
// Contract:
//   * `injectManagedBlock(existing, managed, { begin, end })` returns a string
//     that is ALWAYS safe to write back:
//       - if `existing` is null/empty: a new file containing a short header,
//         the managed block, nothing else.
//       - if `existing` already contains a matching begin/end pair: the inner
//         bytes are replaced with `managed`. Everything outside is preserved
//         byte-for-byte, including the user's original line endings.
//       - if `existing` does NOT contain the markers: the managed block is
//         appended at the end of the file with a blank line separator.
//   * `removeManagedBlock(existing, { begin, end })` returns the file content
//     with the managed block (and its markers) removed. Everything else is
//     preserved byte-for-byte. Used by --uninstall.
//   * First-occurrence semantics for the begin marker and last-occurrence for
//     end, so if the user ever pastes our marker string as prose, the outer
//     pair is still treated as authoritative (and the inner text is what gets
//     replaced, not the user's surrounding prose). If the markers appear
//     multiple times or in a non-matching order, the function throws — the
//     caller is expected to surface a diagnostic; it is never safe to guess
//     in that case.
//
// No state is stored anywhere other than the target file itself. Zero external
// dependencies.

/**
 * @param {string | null} existing  current file content, or null when the file is absent
 * @param {string} managed           the block body (no markers) to write between the markers
 * @param {{ begin: string, end: string, preamble?: string }} markers
 * @returns {string} the updated file content
 */
export function injectManagedBlock(existing, managed, markers) {
  assertValidMarkers(markers);
  const body = ensureTrailingNewline(managed);
  const block = `${markers.begin}\n${body}${markers.end}\n`;
  if (existing == null || existing === "") {
    const preamble = markers.preamble ? ensureTrailingNewline(markers.preamble) + "\n" : "";
    return `${preamble}${block}`;
  }
  const indices = locateMarkers(existing, markers);
  if (indices == null) {
    // No markers: append the block at the end of the file, preserving a
    // single blank-line separator when the existing content does not already
    // end with a newline.
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${block}`;
  }
  const { beginLineStart, endLineEnd } = indices;
  // Preserve a leading BOM if the user's file started with one: otherwise
  // our newline-trim logic would silently strip it, breaking the
  // byte-for-byte guarantee advertised in INSTALL.md.
  const hadBom = existing.charCodeAt(0) === 0xfeff;
  const before = existing.slice(0, beginLineStart);
  const after = existing.slice(endLineEnd);
  const beforeTrim = before.replace(/\n+$/, "");
  const afterTrim = after.replace(/^\n+/, "");
  const bomPrefix = hadBom && !beforeTrim.startsWith("\uFEFF") ? "\uFEFF" : "";
  const joiner = beforeTrim.length === 0 ? "" : "\n\n";
  const trailer = afterTrim.length === 0 ? "" : "\n\n";
  return `${bomPrefix}${beforeTrim}${joiner}${block}${trailer}${afterTrim}`;
}

/**
 * @param {string} existing
 * @param {{ begin: string, end: string }} markers
 * @returns {string} content with the managed block removed; or the original content if no markers are present.
 */
export function removeManagedBlock(existing, markers) {
  assertValidMarkers(markers);
  if (!existing) return existing ?? "";
  // Uninstall must be maximally tolerant: a dangling begin-without-end is
  // probably user damage, not our doing. Degrade to "no change" + signal via
  // return value equality, so the caller can log "already absent".
  let indices;
  try {
    indices = locateMarkers(existing, markers);
  } catch {
    return existing;
  }
  if (indices == null) return existing;
  const { beginLineStart, endLineEnd } = indices;
  // Trim trailing / leading runs of blank lines (sequences of `\r?\n`)
  // on each side. The intent is to collapse the gap left by the
  // removed block, NOT to scrub leading/trailing tabs or spaces on
  // surrounding lines. CRLF files (common on Windows checkouts) end
  // lines with `\r\n`; the previous `/\n+$/` and `/^\n+/` left a
  // stray `\r` adjacent to the strip site. The `\r?` matches both
  // forms so the remaining content is self-consistent regardless of
  // the file's EOL flavour.
  const before = existing.slice(0, beginLineStart).replace(/(?:\r?\n)+$/, "");
  const after = existing.slice(endLineEnd).replace(/^(?:\r?\n)+/, "");
  // Detect the file's prevailing EOL once so we re-emit the separator
  // in the same flavour. The first newline observed wins (matches the
  // detectEol helper convention used by seed.mjs / append-entry.mjs).
  const eol = detectEol(existing);
  if (before.length === 0) return after;
  if (after.length === 0) return before + eol;
  return `${before}${eol}${eol}${after}`;
}

function detectEol(text) {
  if (typeof text !== "string" || text.length === 0) return "\n";
  const idx = text.indexOf("\n");
  if (idx === -1) return "\n";
  return idx > 0 && text[idx - 1] === "\r" ? "\r\n" : "\n";
}

/** Locate the begin/end line offsets in `existing`. Returns null when missing. */
function locateMarkers(existing, { begin, end }) {
  const beginIdx = findLineContaining(existing, begin, /* fromIndex */ 0);
  if (beginIdx === -1) return null;
  const endIdx = findLineContaining(existing, end, beginIdx + begin.length);
  if (endIdx === -1) {
    throw new Error(
      `injectManagedBlock: begin marker present without matching end marker. Refusing to guess.`
    );
  }
  // beginLineStart = the position of the first character of the line that
  // carries the begin marker; endLineEnd = one past the end of the end
  // marker's line (i.e. inclusive of its trailing newline, if any).
  const beginLineStart = lineStart(existing, beginIdx);
  const endLineEnd = lineEndInclusive(existing, endIdx + end.length);
  return { beginLineStart, endLineEnd };
}

/** Returns the index where `needle` appears AS a whole line (or line prefix), or -1. */
function findLineContaining(haystack, needle, fromIndex) {
  let i = fromIndex;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) return -1;
    // Confirm the match starts at a line boundary. Valid boundaries:
    //   - start of string (idx === 0)
    //   - immediately after a newline
    //   - immediately after a UTF-8 BOM at position 0 (common for files
    //     edited by Windows tools). Without this, a BOM-prefixed marker at
    //     offset 0 would be invisible and the installer would append a
    //     second managed block on every --update.
    const prev = haystack[idx - 1];
    if (idx === 0) return idx;
    if (prev === "\n") return idx;
    if (idx === 1 && haystack.charCodeAt(0) === 0xfeff) return idx;
    i = idx + needle.length;
  }
}

/** Find the start of the line that contains position `pos`. */
function lineStart(s, pos) {
  const nl = s.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Return one past the end-of-line for the line that contains position `pos`. */
function lineEndInclusive(s, pos) {
  const nl = s.indexOf("\n", pos);
  return nl === -1 ? s.length : nl + 1;
}

function ensureTrailingNewline(s) {
  return s.endsWith("\n") ? s : s + "\n";
}

function assertValidMarkers({ begin, end }) {
  if (typeof begin !== "string" || typeof end !== "string" || !begin || !end) {
    throw new Error("injectManagedBlock: begin and end markers must be non-empty strings");
  }
  if (begin === end) {
    throw new Error("injectManagedBlock: begin and end markers must differ");
  }
  if (begin.includes("\n") || end.includes("\n")) {
    throw new Error("injectManagedBlock: markers must be single-line strings");
  }
}
