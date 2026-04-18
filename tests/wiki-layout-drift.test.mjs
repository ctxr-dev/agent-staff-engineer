// wiki-layout-drift.test.mjs
// Catch new bundle docs that talk about writing under
// `.development/shared/{reports,plans,runbooks}/` but forget to mandate the
// nested scalable layout. The failure mode we are preventing:
//
//   - Someone adds a new skill (or edits a rule) that tells the agent to
//     write under `.development/shared/reports/`.
//   - They forget the "{yyyy}/{mm}/{dd}" nesting requirement.
//   - Nothing fails, drift compounds.
//
// This test scans every .md file in rules/, skills/, and design/; for each
// file that names one of the governed topic paths, it requires that the
// same file also carries the nested-layout mandate (directly or by pointing
// at rules/llm-wiki.md, which does carry it).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = dirname(dirname(fileURLToPath(import.meta.url)));

const SCAN_DIRS = ["rules", "skills", "design"];

const GOVERNED_TOPIC_RE = /\.development\/(shared|local|cache)\/(reports|plans|runbooks)\b/;

// A file satisfies the rule if it either mandates the nesting directly, or
// explicitly delegates to `rules/llm-wiki.md` (which does).
const MANDATE_DIRECT = /\{yyyy\}\/\{mm\}\/\{dd\}/;
const MANDATE_DELEGATE = /rules\/llm-wiki(\.md)?\b/;

async function walkMarkdown(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkMarkdown(p, acc);
    else if (e.isFile() && e.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

describe("wiki-layout drift: every doc that writes under a governed topic mandates nesting", () => {
  it("scans rules/, skills/, and design/ markdown and enforces the rule", async () => {
    const offenders = [];
    for (const sub of SCAN_DIRS) {
      const files = await walkMarkdown(join(BUNDLE, sub));
      for (const path of files) {
        const body = await readFile(path, "utf8");
        if (!GOVERNED_TOPIC_RE.test(body)) continue;
        if (MANDATE_DIRECT.test(body) || MANDATE_DELEGATE.test(body)) continue;
        offenders.push(relative(BUNDLE, path));
      }
    }
    assert.equal(
      offenders.length,
      0,
      `Files reference .development/shared/{reports,plans,runbooks} without mandating nested layout or delegating to rules/llm-wiki.md:\n  ${offenders.join("\n  ")}\n` +
        `Fix: either add the "{yyyy}/{mm}/{dd}" mandate, or cite rules/llm-wiki.md which does.`,
    );
  });
});

describe("wiki-layout drift: memory seed is in place so the rule travels to every installed project", () => {
  it("memory-seeds/wiki-scalable-layout.md exists and declares type: feedback", async () => {
    const body = await readFile(join(BUNDLE, "memory-seeds/wiki-scalable-layout.md"), "utf8");
    assert.match(body, /^---[\s\S]*\ntype:\s*feedback\b/m, "must be a feedback seed");
    assert.match(body, /\{yyyy\}\/\{mm\}\/\{dd\}/);
    assert.match(body, /flat[- ]?(date[- ]?prefixed|sibling)/i);
    assert.match(body, /\.v\d|versioned filename/i);
  });
});
