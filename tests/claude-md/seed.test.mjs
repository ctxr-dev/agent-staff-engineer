// Tests for scripts/lib/claude-md/seed.mjs
//
// The seeder owns ONE marker pair inside CLAUDE.md. The contract:
//   1. Absent CLAUDE.md   -> create one with the registry stub.
//   2. Existing CLAUDE.md, no markers -> append the stub at the end,
//      preserving every byte of the user's prose.
//   3. Existing CLAUDE.md, markers already present -> NO-OP. The block
//      may have been edited by append-entry.mjs or hand-authored entries
//      and must not be overwritten.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REGISTRY_BEGIN_MARKER,
  REGISTRY_END_MARKER,
  seedRegistryInContent,
  findRegistryMarkers,
  isPristineRegistryBlock,
  MalformedRegistryError,
} from "../../scripts/lib/claude-md/seed.mjs";

test("seed: absent CLAUDE.md gets a fresh registry block", () => {
  const { content, changed } = seedRegistryInContent(null);
  assert.equal(changed, true);
  assert.ok(content.includes(REGISTRY_BEGIN_MARKER));
  assert.ok(content.includes(REGISTRY_END_MARKER));
  assert.ok(content.includes("## Project context"));
  assert.ok(content.includes("### Patterns that worked"));
  assert.ok(content.includes("### Patterns that failed"));
  assert.ok(content.includes("### Codebase quirks"));
});

test("seed: empty string treated as absent", () => {
  const { content, changed } = seedRegistryInContent("");
  assert.equal(changed, true);
  assert.ok(content.includes(REGISTRY_BEGIN_MARKER));
});

test("seed: existing CLAUDE.md without markers gets the block appended, prose preserved", () => {
  const existing = "# Project CLAUDE.md\n\nUser-authored content.\n";
  const { content, changed } = seedRegistryInContent(existing);
  assert.equal(changed, true);
  // User content preserved verbatim at the start of the file.
  assert.ok(content.startsWith("# Project CLAUDE.md\n\nUser-authored content.\n"));
  // Registry block appended below.
  assert.ok(content.includes(REGISTRY_BEGIN_MARKER));
  assert.ok(content.includes(REGISTRY_END_MARKER));
});

test("seed: re-seeding an already-seeded CLAUDE.md is a NO-OP", () => {
  const { content: first } = seedRegistryInContent(null);
  const { content: second, changed } = seedRegistryInContent(first);
  assert.equal(changed, false);
  assert.equal(second, first, "re-seed must be byte-identical");
});

test("seed: hand-edited block is preserved across re-seed", () => {
  // User runs append-entry.mjs (or hand-edits), then runs install --update
  // again. The seed step must NOT overwrite the existing block.
  const { content: seeded } = seedRegistryInContent(null);
  const handEdited = seeded.replace(
    "[placeholder",
    "Repository tracks orchestrator state in `.claude/state/`. [placeholder",
  );
  const { content: after, changed } = seedRegistryInContent(handEdited);
  assert.equal(changed, false);
  assert.equal(after, handEdited);
});

test("seed: CLAUDE.md with prose AROUND markers preserves the prose verbatim", () => {
  // A pathological-but-valid file: user has prose before AND after the
  // managed block. Re-seed must not touch either side.
  const { content: blockOnly } = seedRegistryInContent(null);
  const wrapped = `Top of file.\n\n${blockOnly}\nFooter prose.\n`;
  const { content: after, changed } = seedRegistryInContent(wrapped);
  assert.equal(changed, false);
  assert.equal(after, wrapped);
});

test("seed: marker quoted inside a code fence is NOT detected as the real block", () => {
  // A user-authored CLAUDE.md that documents the marker shape inside a
  // fenced code block must not trick seedRegistryInContent into thinking
  // the registry is already present. Line-boundary anchoring requires
  // the marker to start at column 0 of its own line; an indented copy
  // inside ```...``` does not qualify.
  const fenced = [
    "# Project CLAUDE.md",
    "",
    "We use this marker for the compound-learning registry:",
    "",
    "```",
    `    ${REGISTRY_BEGIN_MARKER}`,
    "    body",
    `    ${REGISTRY_END_MARKER}`,
    "```",
    "",
    "End.",
    "",
  ].join("\n");
  const { content, changed } = seedRegistryInContent(fenced);
  assert.equal(changed, true, "fenced/indented marker must not satisfy detection");
  assert.ok(content.startsWith(fenced), "user prose preserved verbatim");
  // The newly appended block must be a real, line-anchored marker pair.
  const located = findRegistryMarkers(content);
  assert.ok(located, "real block must be detectable after seed");
});

test("findRegistryMarkers: returns null when markers are missing", () => {
  assert.equal(findRegistryMarkers("# just prose\n\n"), null);
  assert.equal(findRegistryMarkers(""), null);
  assert.equal(findRegistryMarkers(null), null);
});

test("findRegistryMarkers: locates real line-anchored markers", () => {
  const { content } = seedRegistryInContent(null);
  const located = findRegistryMarkers(content);
  assert.ok(located);
  assert.ok(located.begin >= 0);
  assert.ok(located.end > located.begin);
});

test("isPristineRegistryBlock: true for fresh seed", () => {
  const { content } = seedRegistryInContent(null);
  assert.equal(isPristineRegistryBlock(content), true);
});

test("isPristineRegistryBlock: false when user added an entry", () => {
  const { content: seeded } = seedRegistryInContent(null);
  // Simulate a user appending a real entry inside the block.
  const dirty = seeded.replace(
    "### Patterns that worked\n\n",
    "### Patterns that worked\n\n### Pattern: Cache invalidation\n- Status: worked\n- First seen: 2026-04-01.\n\n",
  );
  assert.equal(isPristineRegistryBlock(dirty), false);
});

test("isPristineRegistryBlock: tolerates CRLF newlines from a Windows checkout", () => {
  const { content } = seedRegistryInContent(null);
  const crlf = content.replace(/\n/g, "\r\n");
  assert.equal(isPristineRegistryBlock(crlf), true);
});

test("isPristineRegistryBlock: false when no markers present", () => {
  assert.equal(isPristineRegistryBlock("# unrelated content\n"), false);
  assert.equal(isPristineRegistryBlock(""), false);
});

test("seed: BOM-prefixed CLAUDE.md is detected as already seeded (no double-block)", () => {
  // A Windows editor that auto-prefixes \uFEFF would push the begin
  // marker to index 1. Without BOM tolerance, the seeder concluded
  // "no markers present" and appended a second block on every re-seed.
  const { content: seeded } = seedRegistryInContent(null);
  const bomFile = "\uFEFF" + seeded;
  const { content: after, changed } = seedRegistryInContent(bomFile);
  assert.equal(changed, false, "BOM-prefixed seeded file must be a no-op");
  assert.equal(after, bomFile, "byte-stable on re-seed");
  // Sanity: only one begin marker after re-seed.
  const markerCount = after.split(REGISTRY_BEGIN_MARKER).length - 1;
  assert.equal(markerCount, 1);
});

test("findRegistryMarkers: throws MalformedRegistryError on half-pair (begin without end)", () => {
  const half = `# top\n\n${REGISTRY_BEGIN_MARKER}\nbody only\n`;
  assert.throws(() => findRegistryMarkers(half), MalformedRegistryError);
});

test("findRegistryMarkers: throws MalformedRegistryError on half-pair (end without begin)", () => {
  const half = `# top\n\nbody only\n${REGISTRY_END_MARKER}\n`;
  assert.throws(() => findRegistryMarkers(half), MalformedRegistryError);
});

test("findRegistryMarkers: throws MalformedRegistryError when end appears before begin", () => {
  const inverted = `# top\n${REGISTRY_END_MARKER}\nbody\n${REGISTRY_BEGIN_MARKER}\n`;
  assert.throws(() => findRegistryMarkers(inverted), MalformedRegistryError);
});

test("seed: malformed marker pair throws (fail-fast, no silent double block)", () => {
  // The previous behaviour was "treat half-broken as no markers" which
  // produced a dangling marker AND a fresh block. Now the seeder fails
  // fast so install / append-entry can surface the diagnostic and the
  // user repairs the file by hand.
  const half = `# user prose\n\n${REGISTRY_BEGIN_MARKER}\nuser-edited body but missing end\n`;
  assert.throws(() => seedRegistryInContent(half), MalformedRegistryError);
});

test("isPristineRegistryBlock: returns false on malformed markers (does not throw)", () => {
  const half = `# top\n\n${REGISTRY_BEGIN_MARKER}\nbody only\n`;
  // Uninstall calls this to decide whether to strip; throwing here
  // would block uninstall on a damaged CLAUDE.md the user can no
  // longer fix from inside the bundle. Returning false preserves the
  // half-broken block; install / append-entry still surface the error
  // on the next mutating run.
  assert.equal(isPristineRegistryBlock(half), false);
});
