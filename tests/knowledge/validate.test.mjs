// Tests for scripts/lib/knowledge/validate.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateEntry } from "../../scripts/lib/knowledge/validate.mjs";

const validData = () => ({
  id: "pr-iteration-bot-id",
  type: "leaf",
  depth_role: "leaf",
  focus: "PR iteration must cache bot node IDs per repo",
  covers: ["pr-iteration"],
  parents: ["patterns"],
  kind: "pattern",
  first_seen: "2026-04-10",
  last_verified: "2026-04-28",
  source: "PR #123",
  status: "active",
});

const validPath = "/abs/wiki/knowledge/patterns/pr-iteration-bot-id.md";

test("validateEntry: a fully-valid object passes", () => {
  const r = validateEntry(validData(), validPath);
  assert.deepEqual(r, { ok: true, errors: [] });
});

test("validateEntry: missing required fields fail with explicit messages", () => {
  const r = validateEntry({ id: "x" }, "/abs/wiki/knowledge/patterns/x.md");
  assert.equal(r.ok, false);
  // We expect at least one error per missing required field.
  assert.ok(r.errors.length >= 5);
});

test("validateEntry: id pattern enforced", () => {
  const r = validateEntry({ ...validData(), id: "Has Spaces" }, "/abs/wiki/knowledge/patterns/has-spaces.md");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("/id")));
});

test("validateEntry: id must equal filename basename", () => {
  const r = validateEntry(validData(), "/abs/wiki/knowledge/patterns/different-slug.md");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("must match the filename basename")));
});

test("validateEntry: last_verified must be >= first_seen", () => {
  const r = validateEntry(
    { ...validData(), first_seen: "2026-04-28", last_verified: "2026-04-01" },
    validPath,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("last_verified must be >= first_seen")));
});

test("validateEntry: parents must not include the entry's own id", () => {
  const r = validateEntry(
    { ...validData(), parents: ["pr-iteration-bot-id"] },
    validPath,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("parents must not include the entry's own id")));
});

test("validateEntry: type must be 'leaf' for entries under knowledge/", () => {
  const r = validateEntry({ ...validData(), type: "cluster" }, validPath);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('/type must be "leaf"')));
});

test("validateEntry: knowledge/ segment detected on cross-style paths (POSIX + Windows)", () => {
  // The path-separator check must be platform-agnostic so a Windows host
  // that received a POSIX path (and vice versa) still applies the
  // "type must be leaf" invariant. Without segment-splitting, the check
  // would silently pass on a non-leaf entry depending on slash direction.
  const winPath = "C:\\repo\\wiki\\knowledge\\patterns\\pr-iteration-bot-id.md";
  const posixPath = "/abs/wiki/knowledge/patterns/pr-iteration-bot-id.md";
  for (const p of [winPath, posixPath]) {
    const r = validateEntry({ ...validData(), type: "cluster" }, p);
    assert.equal(r.ok, false, `should reject cluster type on path: ${p}`);
    assert.ok(r.errors.some((e) => e.includes('/type must be "leaf"')));
  }
});

test("validateEntry: kind enum enforced", () => {
  const r = validateEntry({ ...validData(), kind: "rumour" }, validPath);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("/kind")));
});

test("validateEntry: status enum enforced", () => {
  const r = validateEntry({ ...validData(), status: "broken" }, validPath);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("/status")));
});

test("validateEntry: extra unknown properties rejected", () => {
  const r = validateEntry({ ...validData(), nonsense: 42 }, validPath);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.toLowerCase().includes("additional")));
});

test("validateEntry: optional fields with undefined value are accepted (matches on-disk shape)", () => {
  // serialiseEntry / orderedFrontmatter strip undefined keys before
  // writing to disk. validateEntry mirrors that contract: a caller
  // that spreads optionals (e.g. `{...base, entities: maybeArr}` with
  // maybeArr === undefined) gets the entry validated against what
  // would actually land in the file, NOT against the JS object.
  const data = {
    ...validData(),
    entities: undefined,
    related: undefined,
    shared_covers: undefined,
  };
  const r = validateEntry(data, validPath);
  assert.equal(r.ok, true, `expected valid; got errors: ${r.errors.join(", ")}`);
});
