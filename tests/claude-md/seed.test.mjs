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
