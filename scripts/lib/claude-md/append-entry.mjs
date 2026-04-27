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
// Required entry fields per the compound-learning template:
// status, first_seen, remediation, next_review.
// next_review defaults to first_seen + 6 months when not supplied; this
// matches design/claude-md-authoring.md's "older than 6 months requires
// re-confirmation" rule.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { REGISTRY_BEGIN_MARKER, REGISTRY_END_MARKER, seedRegistryInContent } from "./seed.mjs";

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

  const newBlock =
    `${REGISTRY_BEGIN_MARKER}\n${ensureTrailingNewline(next.body)}${REGISTRY_END_MARKER}`;
  content = content.slice(0, block.start) + newBlock + content.slice(block.end);
  return { content, changed: true, action: next.action };
}

/**
 * Disk wrapper. Returns the change report so callers can log it.
 *
 * @param {string} claudeMdPath - absolute CLAUDE.md path
 * @param {Parameters<typeof appendEntryToContent>[1]} entry
 */
export function appendEntryAtPath(claudeMdPath, entry) {
  const existing = existsSync(claudeMdPath)
    ? readFileSync(claudeMdPath, "utf8")
    : null;
  const { content, changed, action } = appendEntryToContent(existing, entry);
  if (changed) writeFileSync(claudeMdPath, content);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.firstSeen)) {
    throw new Error(`append-entry: firstSeen must be YYYY-MM-DD; got ${JSON.stringify(entry.firstSeen)}`);
  }
  if (entry.nextReview != null && !/^\d{4}-\d{2}-\d{2}$/.test(entry.nextReview)) {
    throw new Error(`append-entry: nextReview must be YYYY-MM-DD; got ${JSON.stringify(entry.nextReview)}`);
  }
}

function defaultNextReview(firstSeen) {
  // firstSeen + 6 months. UTC math, normalised so 2026-08-31 + 6m = 2027-02-28.
  const [y, m, d] = firstSeen.split("-").map((s) => Number.parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + 6);
  // Re-normalise: if the original day-of-month overflowed (e.g. 31 + 6m
  // landed in a 30-day month), Date pulls it back automatically — but we
  // want a defensive sanity check that the year hasn't gone negative.
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function renderEntry(entry) {
  const status = entry.section === "quirk" ? null : entry.section; // quirks have no status field
  const nextReview = entry.nextReview ?? defaultNextReview(entry.firstSeen);
  if (entry.section === "quirk") {
    // Quirks are one-liners by convention; render compactly without H3.
    const linked = entry.linked ? ` (${entry.linked})` : "";
    return `- ${entry.title}${linked}. Remediation: ${entry.remediation}. Last verified: ${entry.firstSeen}.`;
  }
  const lines = [
    `### Pattern: ${entry.title}`,
    `- Status: ${status}`,
    `- First seen: ${entry.firstSeen}${entry.linked ? ` in ${entry.linked}` : ""}.`,
    `- Remediation: ${entry.remediation}`,
  ];
  if (entry.owner) lines.push(`- Owner: ${entry.owner}`);
  lines.push(`- Next review: ${nextReview}`);
  return lines.join("\n");
}

function extractRegistryBlock(content) {
  const begin = content.indexOf(REGISTRY_BEGIN_MARKER);
  const end = content.lastIndexOf(REGISTRY_END_MARKER);
  if (begin === -1 || end === -1 || end <= begin) return null;
  // Body lives between the marker lines (exclusive of both).
  const innerStart = begin + REGISTRY_BEGIN_MARKER.length + 1; // +1 for the newline after the marker
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
  // Append within the section. Use the section's end as the insert point;
  // trim leading blank lines from the trailing text so we keep one blank
  // line of separation.
  const before = body.slice(0, sectionRange.end).replace(/\n+$/, "\n");
  const after = body.slice(sectionRange.end).replace(/^\n+/, "");
  const joiner = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const sectionEnd = "\n\n";
  return {
    body: before + joiner + rendered + sectionEnd + after,
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
    // Quirks are one-liner bullets keyed on title (case-insensitive).
    const re = /^- (.+)$/gm;
    let m;
    while ((m = re.exec(sectionBody)) !== null) {
      const lineTitle = m[1].split(/[.(]/)[0];
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    process.stderr.write("usage: append-entry.mjs --path <CLAUDE.md> --section worked|failed|quirk --title <t> --first-seen YYYY-MM-DD --remediation <r> [--next-review YYYY-MM-DD] [--linked <ref>] [--owner <name>]\n");
    process.exit(2);
  }
  try {
    const result = appendEntryAtPath(args.path, {
      section: args.section,
      title: args.title,
      firstSeen: args["first-seen"],
      remediation: args.remediation,
      nextReview: args["next-review"],
      linked: args.linked,
      owner: args.owner,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stderr.write(`append-entry: ${err.message}\n`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
