// Tests for scripts/lib/claude-md/append-entry.mjs
//
// The append helper is the runtime-write API for the compound-learning
// registry. Two contracts matter:
//
//   1. Idempotency: same {section, title} run twice must produce one
//      entry, not two. Knowledge-capture (and ad-hoc CLI use) calls this
//      from triggers that may fire more than once for the same draft.
//
//   2. Non-destructive: entries elsewhere in the registry, plus all
//      content outside the marker pair, stay byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";

import { appendEntryToContent } from "../../scripts/lib/claude-md/append-entry.mjs";
import { seedRegistryInContent } from "../../scripts/lib/claude-md/seed.mjs";

function freshlySeeded() {
  return seedRegistryInContent(null).content;
}

test("append: validation rejects missing required fields", () => {
  const seeded = freshlySeeded();
  assert.throws(
    () => appendEntryToContent(seeded, { section: "worked" }),
    /title is required/,
  );
  assert.throws(
    () => appendEntryToContent(seeded, {
      section: "bogus", title: "x", firstSeen: "2026-04-28", remediation: "y",
    }),
    /section must be one of/,
  );
  assert.throws(
    () => appendEntryToContent(seeded, {
      section: "worked", title: "x", firstSeen: "April 28th", remediation: "y",
    }),
    /firstSeen must be YYYY-MM-DD/,
  );
});

test("append: worked entry lands under 'Patterns that worked' with default next-review and a Linked bullet", () => {
  const seeded = freshlySeeded();
  const { content, changed, action } = appendEntryToContent(seeded, {
    section: "worked",
    title: "PR iteration must cache bot node IDs per repo",
    firstSeen: "2026-04-10",
    remediation: "capture bot ID once; see rules/pr-iteration.md",
    linked: "PR #123",
  });
  assert.equal(changed, true);
  assert.equal(action, "added");
  const idxSection = content.indexOf("### Patterns that worked");
  const idxEntry = content.indexOf("### Pattern: PR iteration must cache bot node IDs per repo");
  const idxFailedSection = content.indexOf("### Patterns that failed");
  assert.ok(idxSection !== -1);
  assert.ok(idxEntry > idxSection, "entry must appear AFTER the section heading");
  assert.ok(idxEntry < idxFailedSection, "entry must appear BEFORE the next section");
  assert.ok(content.includes("- Status: worked"));
  assert.ok(content.includes("- First seen: 2026-04-10."));
  // Linked is now a dedicated bullet (matches templates/claude-md/compound-learning.md).
  assert.ok(content.includes("- Linked: PR #123"));
  assert.ok(content.includes("- Remediation: capture bot ID once; see rules/pr-iteration.md"));
  // Default next-review = first-seen + 6 months.
  assert.ok(content.includes("- Next review: 2026-10-10"));
});

test("append: defaultNextReview clamps end-of-month dates instead of rolling forward", () => {
  // 2026-08-31 + 6 months has no Feb 31; setUTCMonth would roll into
  // March. The clamp logic produces 2027-02-28 (the last day of the
  // target month).
  const seeded = freshlySeeded();
  const { content } = appendEntryToContent(seeded, {
    section: "worked",
    title: "End-of-month clamp",
    firstSeen: "2026-08-31",
    remediation: "X",
  });
  assert.ok(content.includes("- Next review: 2027-02-28"));
});

test("append: quirk title with dots and parentheses survives idempotent upsert", () => {
  // Titles like "v2.0 build" or "Node (LTS) is required" must not be
  // truncated by the quirk-line title extraction.
  const seeded = freshlySeeded();
  const a = appendEntryToContent(seeded, {
    section: "quirk",
    title: "Node (LTS) is required for the postinstall hook",
    firstSeen: "2026-04-28",
    remediation: "see scripts/postinstall.sh",
  });
  assert.equal(a.action, "added");
  // Re-running with the same title hits the existing entry, NOT a duplicate.
  const b = appendEntryToContent(a.content, {
    section: "quirk",
    title: "Node (LTS) is required for the postinstall hook",
    firstSeen: "2026-04-28",
    remediation: "see scripts/postinstall.sh",
  });
  assert.notEqual(b.action, "added");
  const matches = b.content.match(/^- Node \(LTS\) is required/gm) ?? [];
  assert.equal(matches.length, 1);
});

test("append: tolerates CRLF newline after the registry begin marker", () => {
  // A CLAUDE.md from a CRLF checkout has \r\n line endings. The block
  // extractor must skip the \r\n after the begin marker so the body
  // slice doesn't start with a stray \r.
  const lf = freshlySeeded();
  const crlf = lf.replace(/\n/g, "\r\n");
  const { content, action } = appendEntryToContent(crlf, {
    section: "worked",
    title: "CRLF round-trip",
    firstSeen: "2026-04-28",
    remediation: "X",
  });
  assert.equal(action, "added");
  assert.ok(content.includes("### Pattern: CRLF round-trip"));
});

test("append: idempotent for same {section, title}", () => {
  const seeded = freshlySeeded();
  const entry = {
    section: "worked",
    title: "Cache bot node IDs",
    firstSeen: "2026-04-10",
    remediation: "see rules/pr-iteration.md",
  };
  const a = appendEntryToContent(seeded, entry);
  assert.equal(a.action, "added");

  const b = appendEntryToContent(a.content, entry);
  // Same content -> "noop" (no diff).
  assert.equal(b.action, "noop");
  assert.equal(b.content, a.content);

  // Updating one field -> "updated", still one entry total.
  const c = appendEntryToContent(a.content, { ...entry, remediation: "see rules/pr-iteration.md and feedback memory" });
  assert.equal(c.action, "updated");
  // Exactly one occurrence of the H3.
  const matches = c.content.match(/### Pattern: Cache bot node IDs/g) ?? [];
  assert.equal(matches.length, 1);
  assert.ok(c.content.includes("see rules/pr-iteration.md and feedback memory"));
});

test("append: case-insensitive title match collapses near-duplicates", () => {
  const seeded = freshlySeeded();
  const a = appendEntryToContent(seeded, {
    section: "worked",
    title: "Cache bot node IDs",
    firstSeen: "2026-04-10",
    remediation: "X",
  });
  const b = appendEntryToContent(a.content, {
    section: "worked",
    title: "cache  bot   node ids",
    firstSeen: "2026-04-10",
    remediation: "X",
  });
  // The variant title should hit the same entry, not append a new one.
  assert.notEqual(b.action, "added");
  const matches = b.content.match(/### Pattern: /g) ?? [];
  assert.equal(matches.length, 1);
});

test("append: failed entry lands under 'Patterns that failed'", () => {
  const seeded = freshlySeeded();
  const { content, action } = appendEntryToContent(seeded, {
    section: "failed",
    title: "Tried single-shot rewrites of orchestrator",
    firstSeen: "2026-03-01",
    remediation: "revert to small PRs scoped to one state; see PR #4",
  });
  assert.equal(action, "added");
  const idxFailed = content.indexOf("### Patterns that failed");
  const idxQuirk = content.indexOf("### Codebase quirks");
  const idxEntry = content.indexOf("### Pattern: Tried single-shot rewrites of orchestrator");
  assert.ok(idxFailed < idxEntry && idxEntry < idxQuirk);
  assert.ok(content.includes("- Status: failed"));
});

test("append: quirk entry renders as one-liner under 'Codebase quirks'", () => {
  const seeded = freshlySeeded();
  const { content, action } = appendEntryToContent(seeded, {
    section: "quirk",
    title: "main is the deploy branch; release/* is hotfix-only",
    firstSeen: "2026-04-28",
    remediation: "branch from main for new features",
  });
  assert.equal(action, "added");
  // Quirk one-liners use a leading `- ` bullet, no H3.
  assert.ok(content.includes("- main is the deploy branch; release/* is hotfix-only"));
  // No H3 added for quirks.
  const sectionStart = content.indexOf("### Codebase quirks");
  const tail = content.slice(sectionStart);
  // Only the section heading is an H3 in the quirks slice.
  const h3Count = (tail.match(/^### /gm) ?? []).length;
  assert.equal(h3Count, 1);
});

test("append: explicit next-review overrides the default", () => {
  const seeded = freshlySeeded();
  const { content } = appendEntryToContent(seeded, {
    section: "worked",
    title: "Custom review date",
    firstSeen: "2026-04-10",
    remediation: "X",
    nextReview: "2027-01-15",
  });
  assert.ok(content.includes("- Next review: 2027-01-15"));
});

test("append: content outside the registry block is preserved byte-for-byte", () => {
  // User has prose before and after the markers; append must not touch it.
  const seeded = freshlySeeded();
  const wrapped = `# Project CLAUDE.md\n\nMy own notes.\n\n${seeded}\nFooter line.\n`;
  const { content } = appendEntryToContent(wrapped, {
    section: "worked",
    title: "Outside-preservation check",
    firstSeen: "2026-04-28",
    remediation: "X",
  });
  assert.ok(content.startsWith("# Project CLAUDE.md\n\nMy own notes.\n\n"));
  assert.ok(content.endsWith("Footer line.\n"));
});

test("append: seeds a registry block when CLAUDE.md is absent", () => {
  // null -> seed -> append, all in one call.
  const { content, action } = appendEntryToContent(null, {
    section: "worked",
    title: "First entry on a fresh repo",
    firstSeen: "2026-04-28",
    remediation: "X",
  });
  assert.equal(action, "added");
  assert.ok(content.includes("### Patterns that worked"));
  assert.ok(content.includes("### Pattern: First entry on a fresh repo"));
});
