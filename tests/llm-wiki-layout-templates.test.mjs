// llm-wiki-layout-templates.test.mjs
// Structural guard for the layout-contract templates shipped at
// templates/llm-wiki-layouts/. These YAMLs encode the nested, scalable
// shape that `rules/llm-wiki.md` mandates. Any future edit that quietly
// removes the dynamic_subdirs template or reverts to a flat date prefix
// must fail this suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yamlMod from "js-yaml";
const yaml = yamlMod.default ?? yamlMod;

const BUNDLE = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES_DIR = join(BUNDLE, "templates/llm-wiki-layouts");

async function readContract(filename) {
  const raw = await readFile(join(TEMPLATES_DIR, filename), "utf8");
  return { raw, parsed: yaml.load(raw) };
}

describe("llm-wiki layout templates: all three expected contracts are present", () => {
  it("ships exactly reports / plans / runbooks yaml files", async () => {
    const entries = (await readdir(TEMPLATES_DIR))
      .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
      .sort();
    assert.deepEqual(entries, [
      "plans.llmwiki.layout.yaml",
      "reports.llmwiki.layout.yaml",
      "runbooks.llmwiki.layout.yaml",
    ]);
  });
});

describe("llm-wiki layout templates: common invariants on every contract", () => {
  const names = [
    "reports.llmwiki.layout.yaml",
    "plans.llmwiki.layout.yaml",
    "runbooks.llmwiki.layout.yaml",
  ];

  for (const name of names) {
    it(`${name} declares mode: hosted`, async () => {
      const { parsed } = await readContract(name);
      assert.equal(parsed.mode, "hosted", `${name} must be a hosted-mode contract`);
    });

    it(`${name} has a non-empty layout[] array`, async () => {
      const { parsed } = await readContract(name);
      assert.ok(Array.isArray(parsed.layout) && parsed.layout.length > 0);
    });

    it(`${name} carries global_invariants forbidding flat leaves and versioned filenames`, async () => {
      const { raw } = await readContract(name);
      assert.match(
        raw,
        /flat/i,
        `${name} must mention "flat" in its invariants/comments so future edits see the rule`,
      );
      assert.match(
        raw,
        /\.v\d|versioned filename/i,
        `${name} must call out that hand-rolled versioned filenames are forbidden`,
      );
    });

    it(`${name} never advertises a flat date-prefix template like {yyyy}-{mm}-{dd} for leaves`, async () => {
      const { raw } = await readContract(name);
      // A template string of the form "{yyyy}-{mm}-{dd}" (with hyphens, no
      // slashes) would be a flat per-day folder name like `2026-04-18/`.
      // That is ambiguous enough to invite flat-sibling regressions; we
      // require `{yyyy}/{mm}/{dd}` everywhere we use a date template.
      const flatDate = /template:\s*["']?\{yyyy\}-\{mm\}-\{dd\}/;
      assert.ok(
        !flatDate.test(raw),
        `${name} must use "{yyyy}/{mm}/{dd}" with slashes, not a flat "{yyyy}-{mm}-{dd}" template`,
      );
    });
  }
});

describe("llm-wiki layout templates: dated topics use {yyyy}/{mm}/{dd}", () => {
  it("reports.llmwiki.layout.yaml has dynamic_subdirs.template = {yyyy}/{mm}/{dd}", async () => {
    const { parsed } = await readContract("reports.llmwiki.layout.yaml");
    const root = parsed.layout.find((s) => s.path === ".");
    assert.ok(root, "reports contract must declare a root layout entry");
    assert.equal(root.dynamic_subdirs?.template, "{yyyy}/{mm}/{dd}");
  });

  it("plans.llmwiki.layout.yaml nests drafts by {yyyy}/{mm}/{dd} and carries a tracks subtree for subjects", async () => {
    const { parsed } = await readContract("plans.llmwiki.layout.yaml");
    const drafts = parsed.layout.find((s) => s.path === "drafts");
    const tracks = parsed.layout.find((s) => s.path === "tracks");
    assert.ok(drafts, "plans contract must declare a drafts subtree");
    assert.equal(drafts.dynamic_subdirs?.template, "{yyyy}/{mm}/{dd}");
    assert.ok(tracks, "plans contract must declare a tracks subtree for long-running subjects");
  });
});

describe("llm-wiki layout templates: subject topics nest by category", () => {
  it("runbooks.llmwiki.layout.yaml declares at least three subject folders with purpose", async () => {
    const { parsed } = await readContract("runbooks.llmwiki.layout.yaml");
    const subjectFolders = parsed.layout.filter(
      (s) =>
        typeof s.path === "string" &&
        s.path !== "." &&
        typeof s.purpose === "string" &&
        s.purpose.length > 0 &&
        !s.dynamic_subdirs,
    );
    assert.ok(
      subjectFolders.length >= 3,
      `runbooks must ship at least three subject folders, got ${subjectFolders.length}`,
    );
    for (const s of subjectFolders) {
      assert.ok(
        /^[a-z][a-z0-9-]*$/.test(s.path),
        `subject folder path "${s.path}" must be a simple lowercase slug`,
      );
    }
  });

  it("runbooks.llmwiki.layout.yaml does not put anything at the root via dynamic_subdirs", async () => {
    const { parsed } = await readContract("runbooks.llmwiki.layout.yaml");
    for (const s of parsed.layout) {
      assert.ok(
        !(s.path === "." && s.dynamic_subdirs),
        "runbooks is a subject topic: the root must not be a dated-subdir container",
      );
    }
  });
});
