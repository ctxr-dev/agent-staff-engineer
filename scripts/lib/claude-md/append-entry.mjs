// scripts/lib/claude-md/append-entry.mjs
//
// Append (or upsert) a compound-learning entry inside a project's
// CLAUDE.md, between the registry markers seeded by seed.mjs.
//
// Idempotency contract: running with the same {section, title} twice
// updates the existing entry in place rather than producing a duplicate.
// The match key is the H3 line `### Pattern: <title>` (case-insensitive,
// whitespace-collapsed). This keeps the helper safe to invoke from a
// future skills/knowledge-capture trigger that may fire more than once
// for the same draft.
//
// Public API (camelCase JS shape):
//   { section: "worked" | "failed" | "quirk",
//     title: string,                           // required
//     firstSeen: "YYYY-MM-DD",                 // required (worked/failed)
//     remediation: string,                     // required
//     nextReview?: "YYYY-MM-DD",               // worked/failed; defaults to firstSeen + 6 months (end-of-month clamped)
//     linked?: string,                         // optional issue/PR refs
//     owner?: string }                         // worked/failed only
//
// Quirks reuse `firstSeen` as the "last verified" date in the rendered
// output (quirks have no explicit lastVerified field). The renderer
// emits one bullet per quirk: `- <title>[ (linked)]. Remediation: <r>.
// Last verified: <firstSeen>.`
//
// CLI flag names use kebab-case (--first-seen, --next-review); the
// renderer maps camelCase JS keys to the snake_case field names that
// appear in the human-facing markdown output (Status, First seen,
// Linked, Remediation, Owner, Next review).

import { readTextOrNull, atomicWriteText } from "../fsx.mjs";
import {
  REGISTRY_BEGIN_MARKER,
  REGISTRY_END_MARKER,
  seedRegistryInContent,
  findRegistryMarkers,
} from "./seed.mjs";

/**
 * Append or update one compound-learning entry inside a CLAUDE.md string.
 *
 * @param {string | null} existing - current CLAUDE.md content
 * @param {object} entry
 * @param {"worked" | "failed" | "quirk"} entry.section
 * @param {string} entry.title             - one-line H3 title
 * @param {string} entry.firstSeen         - YYYY-MM-DD
 * @param {string} entry.remediation       - one-line pointer
 * @param {string} [entry.nextReview]      - YYYY-MM-DD; defaults to firstSeen + 6 months
 * @param {string} [entry.linked]          - optional issue or PR refs
 * @param {string} [entry.owner]           - optional owner name
 * @returns {{ content: string, changed: boolean, action: "added" | "updated" | "noop" }}
 */
export function appendEntryToContent(existing, entry) {
  validateEntry(entry);

  // Ensure the registry block exists. seedRegistryInContent is a no-op
  // when the markers are already present.
  const seeded = seedRegistryInContent(existing);
  let content = seeded.content;

  const block = extractRegistryBlock(content);
  if (!block) {
    // Should be unreachable — seedRegistryInContent guarantees a block.
    throw new Error("append-entry: registry block missing after seed; cannot proceed");
  }

  const rendered = renderEntry(entry);
  const next = upsertEntry(block.body, entry, rendered);

  if (next.body === block.body) {
    return { content, changed: false, action: "noop" };
  }

  // Preserve the file's existing line-ending style. A CLAUDE.md saved
  // with CRLF (Windows checkout, core.autocrlf=true) should re-emit as
  // CRLF; an LF file should stay LF. Detect the EOL by sampling the
  // ORIGINAL content (not the renderer output, which always emits LF).
  const eol = detectEol(content);
  const blockBody = ensureTrailingNewline(next.body);
  const newBlock = `${REGISTRY_BEGIN_MARKER}\n${blockBody}${REGISTRY_END_MARKER}`;
  const reEoled = eol === "\r\n" ? newBlock.replace(/\r?\n/g, "\r\n") : newBlock;
  content = content.slice(0, block.start) + reEoled + content.slice(block.end);
  return { content, changed: true, action: next.action };
}

function detectEol(text) {
  // Use the FIRST line ending observed; the file is presumed
  // self-consistent. CRLF wins when present at the first newline.
  if (typeof text !== "string" || text.length === 0) return "\n";
  const idx = text.indexOf("\n");
  if (idx === -1) return "\n";
  return idx > 0 && text[idx - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * Disk wrapper. Uses the bundle's atomicWriteText helper (write-to-temp
 * + rename) so the on-disk CLAUDE.md is never partially overwritten.
 * Matches the convention in seed.mjs and scripts/install.mjs.
 *
 * @param {string} claudeMdPath - absolute CLAUDE.md path
 * @param {Parameters<typeof appendEntryToContent>[1]} entry
 * @returns {Promise<{ path: string, changed: boolean, action: "added" | "updated" | "noop" }>}
 */
export async function appendEntryAtPath(claudeMdPath, entry) {
  const existing = await readTextOrNull(claudeMdPath);
  const { content, changed, action } = appendEntryToContent(existing, entry);
  if (changed) await atomicWriteText(claudeMdPath, content);
  return { path: claudeMdPath, changed, action };
}

// ---------- internals ----------

const VALID_SECTIONS = new Set(["worked", "failed", "quirk"]);
const SECTION_HEADING = {
  worked: "### Patterns that worked",
  failed: "### Patterns that failed",
  quirk: "### Codebase quirks",
};

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("append-entry: entry must be an object");
  }
  if (!VALID_SECTIONS.has(entry.section)) {
    throw new Error(
      `append-entry: section must be one of ${[...VALID_SECTIONS].join(", ")}; got ${JSON.stringify(entry.section)}`,
    );
  }
  for (const field of ["title", "firstSeen", "remediation"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      throw new Error(`append-entry: ${field} is required and must be a non-empty string`);
    }
  }
  if (!isValidIsoDate(entry.firstSeen)) {
    throw new Error(`append-entry: firstSeen must be a valid YYYY-MM-DD date; got ${JSON.stringify(entry.firstSeen)}`);
  }
  if (entry.nextReview != null && !isValidIsoDate(entry.nextReview)) {
    throw new Error(`append-entry: nextReview must be a valid YYYY-MM-DD date; got ${JSON.stringify(entry.nextReview)}`);
  }
  // Quirks render only `Last verified: <firstSeen>` and have no Owner
  // bullet. renderEntry silently drops `nextReview` / `owner` for
  // section=quirk; reject them at validation time so a caller mistake
  // (passing those fields to a quirk by accident) surfaces immediately.
  if (entry.section === "quirk") {
    if (entry.nextReview != null) {
      throw new Error("append-entry: nextReview is not valid for section=quirk (quirks render only Last verified)");
    }
    if (entry.owner != null) {
      throw new Error("append-entry: owner is not valid for section=quirk (quirks have no owner field)");
    }
  }
}

/**
 * Strict YYYY-MM-DD validator: regex shape AND a real Date round-trip
 * so impossible dates like 2026-02-31 or 2026-13-05 are rejected.
 * Without the round-trip, defaultNextReview() would happily compute a
 * misleading "Next review" value for a nonexistent input date.
 */
function isValidIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map((p) => Number.parseInt(p, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Date(year, month, day) silently rolls over invalid components
  // (Feb 31 -> Mar 3). Verify the round-trip preserved the input.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function defaultNextReview(firstSeen) {
  // firstSeen + 6 months, with end-of-month CLAMPING (not rollover).
  // Plain `setUTCMonth(m + 6)` rolls 2026-08-31 forward to 2027-03-03
  // because it lands on 2027-02-31 and JS normalises into the next
  // month. We want the last day of the target month instead so the
  // review-cadence semantics match design/claude-md-authoring.md
  // ("older than 6 months requires re-confirmation").
  const [y, m, d] = firstSeen.split("-").map((s) => Number.parseInt(s, 10));
  // Compute target year/month additively. JS months are 0-indexed.
  const startMonthIndex = m - 1;
  const targetMonthIndex = startMonthIndex + 6;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12; // 0-11
  // Days in the target month (UTC). Date(year, month+1, 0) gives the
  // last day of `month` because day=0 means "the last day of the prior
  // month".
  const lastDayOfTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(d, lastDayOfTarget);
  const yy = targetYear;
  const mm = String(targetMonth + 1).padStart(2, "0");
  const dd = String(targetDay).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function renderEntry(entry) {
  const status = entry.section === "quirk" ? null : entry.section; // quirks have no status field
  const nextReview = entry.nextReview ?? defaultNextReview(entry.firstSeen);
  if (entry.section === "quirk") {
    // Quirks are one-liner bullets. The CLI takes a single date input
    // (--first-seen) which the renderer surfaces as "Last verified"
    // because quirks describe stable codebase facts: the relevant
    // datum is "when did a human last confirm this is still true?",
    // not "when was it discovered". The accepted-by-API name stays
    // `firstSeen` to keep one input-validation path; readers see
    // "Last verified" in the bullet.
    const linked = entry.linked ? ` (${entry.linked})` : "";
    return `- ${entry.title}${linked}. Remediation: ${entry.remediation}. Last verified: ${entry.firstSeen}.`;
  }
  // Worked / failed entries follow the registry template's exact shape:
  // Status, First seen, optional Linked, Remediation, optional Owner,
  // Next review. Linked is rendered as its own bullet (matching
  // templates/claude-md/compound-learning.md) so consumers reading the
  // registry get a dedicated, easy-to-grep field.
  const lines = [
    `### Pattern: ${entry.title}`,
    `- Status: ${status}`,
    `- First seen: ${entry.firstSeen}.`,
  ];
  if (entry.linked) lines.push(`- Linked: ${entry.linked}`);
  lines.push(`- Remediation: ${entry.remediation}`);
  if (entry.owner) lines.push(`- Owner: ${entry.owner}`);
  lines.push(`- Next review: ${nextReview}`);
  return lines.join("\n");
}

function extractRegistryBlock(content) {
  // Line-boundary anchored marker detection: a marker quoted inside a
  // code fence or mid-paragraph prose must not be picked up as the real
  // installer-owned block. seed.mjs::findRegistryMarkers enforces the
  // anchoring once for both readers and writers.
  const located = findRegistryMarkers(content);
  if (!located) return null;
  const { begin, end } = located;
  // Body lives between the marker lines (exclusive of both). The newline
  // after the marker may be `\n` (POSIX) or `\r\n` (Windows / a CRLF
  // checkout); skip whichever is there so the body slice doesn't begin
  // with a stray `\r`.
  const afterMarker = begin + REGISTRY_BEGIN_MARKER.length;
  let innerStart = afterMarker;
  if (content[innerStart] === "\r" && content[innerStart + 1] === "\n") {
    innerStart += 2;
  } else if (content[innerStart] === "\n") {
    innerStart += 1;
  }
  return {
    start: begin,
    end: end + REGISTRY_END_MARKER.length,
    body: content.slice(innerStart, end),
  };
}

function ensureTrailingNewline(s) {
  return s.endsWith("\n") ? s : s + "\n";
}

function normaliseTitle(t) {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Extract the title portion from a quirk bullet. The renderer emits
 * `<title>[ (<linked>)]. Remediation: <r>. Last verified: <date>.`
 * — the title boundary is the literal ` (` group OR the literal
 * `. Remediation:` tag. We split on those, not on raw `.` or `(`,
 * so titles containing dots (e.g. "v2.0 build") or parens
 * (e.g. "Node (LTS)") survive.
 */
function extractQuirkTitle(bulletBody) {
  const remIdx = bulletBody.indexOf(". Remediation:");
  let upToTitle = remIdx >= 0 ? bulletBody.slice(0, remIdx) : bulletBody;
  // Strip a trailing ` (...)` linked group if present. Match the LAST
  // occurrence so titles containing parentheses remain intact.
  const linkedMatch = / \([^()]*\)$/.exec(upToTitle);
  if (linkedMatch) upToTitle = upToTitle.slice(0, linkedMatch.index);
  return upToTitle;
}

/**
 * Upsert one entry inside the body of the registry block.
 *
 * Strategy:
 * 1. Locate the section heading (H3) the entry belongs to.
 * 2. Within that section (until the next H3), look for an existing
 *    `### Pattern: <title>` line whose normalised title matches.
 * 3. If found: replace that block (heading + bullet list, until the next
 *    `### ` line OR the next `## ` line OR end-of-section).
 * 4. If not found: append the rendered entry at the end of the section.
 *
 * The function preserves user-authored content elsewhere in the body
 * (project context paragraph, comments, other entries).
 */
function upsertEntry(body, entry, rendered) {
  const heading = SECTION_HEADING[entry.section];
  const sectionRange = locateSection(body, heading);
  if (!sectionRange) {
    // Section heading is missing (e.g. a custom CLAUDE.md without the
    // standard layout). Append the heading + entry at the end of the body.
    const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return {
      body: body + sep + heading + "\n\n" + rendered + "\n",
      action: "added",
    };
  }
  const sectionBody = body.slice(sectionRange.start, sectionRange.end);
  const matchRange = locateExistingEntry(sectionBody, entry);
  if (matchRange) {
    // Replace the matched entry's bytes in place. matchRange.end stops
    // right after the last bullet line (no trailing newline included),
    // so `after` carries the original separator into the next entry.
    // Direct splice preserves the surrounding whitespace exactly, which
    // means re-running with the same input is a true no-op.
    const before = body.slice(0, sectionRange.start + matchRange.start);
    const after = body.slice(sectionRange.start + matchRange.end);
    const newBody = before + rendered + after;
    if (newBody === body) return { body, action: "noop" };
    return { body: newBody, action: "updated" };
  }
  // Append within the section. We splice at the section boundary
  // WITHOUT trimming the user's whitespace on either side; whatever
  // newlines they kept stay intact. The only thing we add is enough
  // separation in front of and after the new entry to keep markdown
  // valid (one blank line either side, no more, no less).
  const before = body.slice(0, sectionRange.end);
  const after = body.slice(sectionRange.end);
  const leadingSep = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trailingSep = after.startsWith("\n\n") || after.length === 0 ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return {
    body: before + leadingSep + rendered + trailingSep + after,
    action: "added",
  };
}

function locateSection(body, heading) {
  // Section starts at the line of `heading` and ends at the next SIBLING
  // section heading (one of the three SECTION_HEADINGs) OR the next H2,
  // OR end-of-body. Crucially, `### Pattern: ...` entry headings inside
  // the section are NOT treated as section boundaries — they are content.
  const SIBLING_HEADINGS = new Set(Object.values(SECTION_HEADING));
  const lines = body.split("\n");
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (SIBLING_HEADINGS.has(trimmed) || trimmed.startsWith("## ")) {
      endLine = i;
      break;
    }
  }
  const start = lines.slice(0, startLine).join("\n");
  const end = lines.slice(0, endLine).join("\n");
  return {
    start: start.length === 0 ? 0 : start.length + 1,
    end: end.length,
  };
}

function locateExistingEntry(sectionBody, entry) {
  const wanted = normaliseTitle(entry.title);
  if (entry.section === "quirk") {
    // Quirks are one-liner bullets `- <title>[ (<linked>)]. Remediation: ...`.
    // Match on the title prefix without splitting on `.` or `(` (titles
    // legitimately contain dots like "v2.0 build" or parens like
    // "Node (LTS) on this repo"); the title boundary is either the
    // optional ` (linked)` group or the literal `. Remediation:` tag.
    const re = /^- (.+)$/gm;
    let m;
    while ((m = re.exec(sectionBody)) !== null) {
      const line = m[1];
      const lineTitle = extractQuirkTitle(line);
      if (normaliseTitle(lineTitle) === wanted) {
        return { start: m.index, end: m.index + m[0].length };
      }
    }
    return null;
  }
  // Worked / failed: H3 entries. Match `### Pattern: <title>` (the
  // template's canonical shape) and also tolerate `### <title>` for
  // hand-authored entries. `### Patterns that worked` / `### Patterns
  // that failed` / `### Codebase quirks` are sibling SECTION headings,
  // not entry headings — skip them defensively.
  const lines = sectionBody.split("\n");
  const SIBLING_HEADINGS = new Set(Object.values(SECTION_HEADING));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("### ")) continue;
    if (SIBLING_HEADINGS.has(line)) continue;
    const titleText = line.replace(/^### (Pattern:\s+)?/, "");
    if (normaliseTitle(titleText) !== wanted) continue;
    // Found the heading. Block ends at the next `### ` or `## ` heading
    // or at end-of-section.
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t.startsWith("### ") || t.startsWith("## ")) break;
      j++;
    }
    // Trim trailing blank lines from the matched range so the replacement
    // does not eat the separator before the next entry.
    while (j > i + 1 && lines[j - 1].trim() === "") j--;
    const before = lines.slice(0, i).join("\n");
    const slice = lines.slice(i, j).join("\n");
    return {
      start: before.length === 0 ? 0 : before.length + 1,
      end: (before.length === 0 ? 0 : before.length + 1) + slice.length,
    };
  }
  return null;
}

// ---------- CLI ----------

// Direct-run detection through pathToFileURL with the `?? ""` form
// matches the convention every other bundle entrypoint uses
// (scripts/adapt.mjs, scripts/preflight.mjs). The empty-string
// fallback handles the rare case where process.argv[1] is undefined
// so pathToFileURL doesn't throw. preflight() runs first so a
// too-old Node version surfaces the same friendly error other CLIs
// produce.
import { pathToFileURL } from "node:url";
import { preflight } from "../../preflight.mjs";

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await preflight();
  await runCli();
}

async function runCli() {
  // Use the bundle's shared parseArgv helper so this CLI's flag
  // parsing matches every other entrypoint (scripts/adapt.mjs,
  // scripts/install.mjs). Three forms supported: --flag,
  // --flag=value, --flag value.
  const { parseArgv } = await import("../argv.mjs");
  const { flags } = parseArgv(process.argv.slice(2));
  if (!flags.path) {
    process.stderr.write("usage: append-entry.mjs --path <CLAUDE.md> --section worked|failed|quirk --title <t> --first-seen YYYY-MM-DD --remediation <r> [--next-review YYYY-MM-DD] [--linked <ref>] [--owner <name>]\n");
    process.exit(2);
  }
  try {
    // appendEntryAtPath is async (it writes via atomicWriteText).
    // Awaiting here ensures errors land in the catch block instead of
    // becoming unhandled promise rejections, and the JSON.stringify
    // below renders the resolved object, not a Promise.
    const result = await appendEntryAtPath(flags.path, {
      section: flags.section,
      title: flags.title,
      firstSeen: flags["first-seen"],
      remediation: flags.remediation,
      nextReview: flags["next-review"],
      linked: flags.linked,
      owner: flags.owner,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stderr.write(`append-entry: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}
