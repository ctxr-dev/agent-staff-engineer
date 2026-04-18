// wiki-layout-guidance.test.mjs
// Drift guard for the "nested scalable wiki layout" rule.
//
// Every bundle document that instructs a write into `.development/shared/**`
// must explicitly mandate the nested layout (dated topics use
// `{yyyy}/{mm}/{dd}`, subject topics use category subfolders) and must
// refuse the two historic failure modes:
//
//   1. flat date-prefixed siblings (e.g. `2026-04-18-foo.md` at the topic root);
//   2. user-visible versioned filenames (e.g. `foo.v1.md`, `foo-v2.md`).
//
// These assertions are content-lint: they fail the build the moment someone
// edits a governing file in a way that weakens or removes the rule. The
// whole point is that this cannot drift silently.
//
// When adding a new file that routes writes under `.development/shared/**`,
// add it to GOVERNING_FILES below so its wording is enforced too.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Files that govern how/where the agent writes under `.development/**`.
 * Every one of these must carry the nesting mandate. This list is the
 * contract: adding a new such file without updating this list is the drift
 * we are preventing.
 */
const GOVERNING_FILES = [
  "rules/llm-wiki.md",
  "skills/dev-loop/SKILL.md",
  "skills/regression-handler/SKILL.md",
  "design/ARCHITECTURE.md",
];

const REQUIRED_NESTING_PHRASES = [
  // The canonical nested-date template string. At least one of these forms
  // must appear, so a search for the template catches every governing file.
  /\{yyyy\}\/\{mm\}\/\{dd\}/,
];

const REQUIRED_ANTIPATTERN_REFUSAL = [
  // Flat date-prefixed siblings must be named and refused explicitly so a
  // future author cannot roll them back in by rewording around a generic
  // "prefer nesting" sentence.
  /flat[- ]?(date[- ]?prefixed|sibling)/i,
];

const REQUIRED_VERSIONING_REFUSAL = [
  // Hand-rolled versioned filenames must be named and refused, too.
  /\.v\d|vN|versioned filename/i,
];

async function readGoverning(path) {
  return readFile(join(BUNDLE, path), "utf8");
}

describe("wiki-layout guidance: nested scalable layout is mandated everywhere", () => {
  for (const path of GOVERNING_FILES) {
    it(`${path} mandates {yyyy}/{mm}/{dd} nesting`, async () => {
      const body = await readGoverning(path);
      for (const re of REQUIRED_NESTING_PHRASES) {
        assert.match(body, re, `${path} must mention the nested template "{yyyy}/{mm}/{dd}"`);
      }
    });

    it(`${path} explicitly refuses flat date-prefixed siblings`, async () => {
      const body = await readGoverning(path);
      const hit = REQUIRED_ANTIPATTERN_REFUSAL.some((re) => re.test(body));
      assert.ok(
        hit,
        `${path} must explicitly name and refuse flat date-prefixed siblings (e.g. "flat date-prefixed" or "flat siblings")`,
      );
    });

    it(`${path} explicitly refuses hand-rolled versioned filenames`, async () => {
      const body = await readGoverning(path);
      const hit = REQUIRED_VERSIONING_REFUSAL.some((re) => re.test(body));
      assert.ok(
        hit,
        `${path} must explicitly refuse hand-rolled versioned filenames like ".v1.md"`,
      );
    });
  }
});

describe("wiki-layout guidance: rule file names the three layout templates", () => {
  it("rules/llm-wiki.md points at templates/llm-wiki-layouts/", async () => {
    const body = await readGoverning("rules/llm-wiki.md");
    assert.match(
      body,
      /templates\/llm-wiki-layouts/,
      "the rule must direct the agent to the shipped layout-contract templates",
    );
  });
});
