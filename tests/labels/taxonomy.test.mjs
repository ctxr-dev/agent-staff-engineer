import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaxonomy, loadTaxonomy, buildExtensionLabels, syncLabelsToRepo } from "../../scripts/lib/labels/sync.mjs";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TAXONOMY_PATH = join(BUNDLE, "templates/labels/default-taxonomy.yaml");

describe("parseTaxonomy", () => {
  it("parses the bundled taxonomy into prefixed labels", async () => {
    const content = await readFile(TAXONOMY_PATH, "utf8");
    const labels = parseTaxonomy(content);
    assert.ok(labels.length >= 10, `expected 10+ labels, got ${labels.length}`);
    assert.ok(labels.some((l) => l.name === "type:feature"));
    assert.ok(labels.some((l) => l.name === "type:bug"));
    assert.ok(labels.some((l) => l.name === "scope:breaking"));
    assert.ok(labels.some((l) => l.name === "area:bootstrap"));
  });

  it("applies default_color when label has no explicit color", () => {
    const content = `
families:
  test:
    default_color: "AABBCC"
    labels:
      - { name: alpha }
      - { name: beta, color: "112233" }
`;
    const labels = parseTaxonomy(content);
    const alpha = labels.find((l) => l.name === "test:alpha");
    const beta = labels.find((l) => l.name === "test:beta");
    assert.equal(alpha.color, "AABBCC");
    assert.equal(beta.color, "112233");
  });

  it("skips families with empty labels array", () => {
    const content = `
families:
  release:
    locked: true
    default_color: "0E8A16"
    labels: []
  type:
    locked: true
    default_color: "0366D6"
    labels:
      - { name: feature }
`;
    const labels = parseTaxonomy(content);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].name, "type:feature");
  });

  it("throws on malformed YAML (missing families key)", () => {
    assert.throws(() => parseTaxonomy("bad: true"), /families/);
  });
});

describe("loadTaxonomy", () => {
  it("loads the bundled taxonomy from disk", async () => {
    const labels = await loadTaxonomy(TAXONOMY_PATH);
    assert.ok(labels.length >= 10);
  });
});

describe("buildExtensionLabels", () => {
  it("builds area extension labels with default color", () => {
    const labels = buildExtensionLabels({ areas: ["crypto", "payments"] });
    assert.equal(labels.length, 2);
    assert.equal(labels[0].name, "area:crypto");
    assert.equal(labels[0].color, "8B4FBC");
  });

  it("builds release and phase extensions", () => {
    const labels = buildExtensionLabels({
      releases: ["v2.0"],
      phases: ["P0-foundations"],
    });
    assert.equal(labels.length, 2);
    assert.ok(labels.some((l) => l.name === "release:v2.0"));
    assert.ok(labels.some((l) => l.name === "phase:P0-foundations"));
  });

  it("returns empty for undefined/null extensions", () => {
    assert.deepEqual(buildExtensionLabels(undefined), []);
    assert.deepEqual(buildExtensionLabels(null), []);
    assert.deepEqual(buildExtensionLabels({}), []);
  });
});

describe("syncLabelsToRepo (stubbed gh)", () => {
  function fakeGh(existingLabels) {
    const created = [];
    return {
      fn: async (args) => {
        if (args[0] === "label" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify(existingLabels), json: existingLabels };
        }
        if (args[0] === "label" && args[1] === "create") {
          created.push(args[2]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unknown command" };
      },
      created,
    };
  }

  it("creates missing labels and skips existing ones", async () => {
    const existing = [{ name: "type:bug", color: "D73A4A", description: "Defect" }];
    const gh = fakeGh(existing);
    const taxonomy = [
      { name: "type:bug", color: "D73A4A", description: "Defect" },
      { name: "type:feature", color: "0366D6", description: "New capability" },
    ];
    const result = await syncLabelsToRepo(taxonomy, "test", "repo", { gh: gh.fn });
    assert.deepEqual(result.created, ["type:feature"]);
    assert.ok(result.skipped.some((s) => s.name === "type:bug"));
  });

  it("reports color diffs on existing labels", async () => {
    const existing = [{ name: "type:bug", color: "FF0000", description: "Defect" }];
    const gh = fakeGh(existing);
    const taxonomy = [{ name: "type:bug", color: "D73A4A", description: "Defect" }];
    const result = await syncLabelsToRepo(taxonomy, "test", "repo", { gh: gh.fn });
    assert.ok(result.diffs.some((d) => d.name === "type:bug" && d.field === "color"));
  });

  it("dedupes taxonomy and extraLabels by name", async () => {
    const gh = fakeGh([]);
    const taxonomy = [{ name: "area:docs", color: "AAA", description: "A" }];
    const extra = [{ name: "area:docs", color: "BBB", description: "B" }];
    const result = await syncLabelsToRepo(taxonomy, "test", "repo", { extraLabels: extra, gh: gh.fn });
    assert.equal(gh.created.length, 1);
    assert.equal(gh.created[0], "area:docs");
  });
});
