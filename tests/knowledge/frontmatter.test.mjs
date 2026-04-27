// Tests for scripts/lib/knowledge/frontmatter.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEntry, serialiseEntry, orderedFrontmatter, FIELD_ORDER } from "../../scripts/lib/knowledge/frontmatter.mjs";

const validData = () => ({
  id: "pr-iteration-bot-id",
  type: "leaf",
  depth_role: "leaf",
  focus: "PR iteration must cache bot node IDs per repo",
  covers: ["pr-iteration", "bot-routing"],
  parents: ["patterns"],
  kind: "pattern",
  entities: ["rules/pr-iteration.md", "scripts/lib/pr-iteration/tick.mjs"],
  related: ["graphql-bot-resolution"],
  first_seen: "2026-04-10",
  last_verified: "2026-04-28",
  source: "PR #123",
  status: "active",
});

test("parseEntry: round-trips frontmatter and body", () => {
  const data = validData();
  const body = "\nDetailed entry body.\n\nWith multiple paragraphs.\n";
  const text = serialiseEntry(data, body);
  const parsed = parseEntry(text);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.content.trim(), "Detailed entry body.\n\nWith multiple paragraphs.");
});

test("serialiseEntry: deterministic ordering across runs", () => {
  // Same inputs in different key insertion order must produce the same bytes.
  const baseline = serialiseEntry(validData(), "Body.\n");
  const reordered = {};
  for (const k of [...Object.keys(validData())].reverse()) reordered[k] = validData()[k];
  const second = serialiseEntry(reordered, "Body.\n");
  assert.equal(second, baseline);
});

test("serialiseEntry: known fields rendered in FIELD_ORDER, extras appended", () => {
  const data = { ...validData(), z_extra: "tail", a_extra: "head" };
  const text = serialiseEntry(data, "");
  // Locate field positions in the rendered output and assert
  // FIELD_ORDER is preserved, with extras after.
  const positions = FIELD_ORDER.filter((k) => k in data).map((k) => text.indexOf(`${k}:`));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${FIELD_ORDER[i]} must follow ${FIELD_ORDER[i - 1]}`);
  }
  // Extras come after everything in FIELD_ORDER.
  const lastKnown = positions[positions.length - 1];
  assert.ok(text.indexOf("a_extra:") > lastKnown);
  assert.ok(text.indexOf("z_extra:") > text.indexOf("a_extra:"));
});

test("serialiseEntry: empty arrays render inline as []", () => {
  const data = { ...validData(), parents: [] };
  const text = serialiseEntry(data, "");
  assert.match(text, /^parents: \[\]$/m);
});

test("serialiseEntry: scalars requiring quotes get JSON-style double quotes", () => {
  const data = { ...validData(), focus: "Has: a colon and # hash" };
  const text = serialiseEntry(data, "");
  assert.match(text, /^focus: "Has: a colon and # hash"$/m);
});

test("serialiseEntry: ISO dates round-trip as strings (quoted to defeat YAML's auto-Date parse)", () => {
  const text = serialiseEntry(validData(), "");
  assert.match(text, /^first_seen: "2026-04-10"$/m);
  assert.match(text, /^last_verified: "2026-04-28"$/m);
  // Round-trip preserves the string type, not a JS Date.
  const parsed = parseEntry(text);
  assert.equal(typeof parsed.data.first_seen, "string");
  assert.equal(parsed.data.first_seen, "2026-04-10");
});

test("orderedFrontmatter: undefined values are dropped", () => {
  const data = { id: "x", type: "leaf", depth_role: "leaf", focus: "", covers: ["a"], parents: [], kind: "pattern", first_seen: "2026-04-28", last_verified: "2026-04-28", source: "x", status: "active", optional: undefined };
  const out = orderedFrontmatter(data);
  assert.ok(!("optional" in out));
});
