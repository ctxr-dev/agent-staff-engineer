import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaxonomy, loadTaxonomy, buildExtensionLabels } from "../../scripts/lib/labels/sync.mjs";

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
