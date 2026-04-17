import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSeed,
  seedApplies,
  collectStackTags,
  formatTags,
  slugifyFilename,
  buildHeaderForMemory,
} from "../scripts/install_memory_seeds.mjs";

describe("install_memory_seeds.parseSeed", () => {
  it("parses a full frontmatter block via gray-matter", () => {
    const text = [
      "---",
      "name: Sample seed",
      "description: Sample one-liner",
      "type: feedback",
      "portable: true",
      "tags:",
      "  language: swift",
      "---",
      "",
      "Body text.",
    ].join("\n");
    const parsed = parseSeed(text);
    assert.equal(parsed.name, "Sample seed");
    assert.equal(parsed.type, "feedback");
    assert.deepEqual(parsed.tags.language, ["swift"]);
  });

  it("handles inline empty tags array (`tags: []`)", () => {
    const text = `---\nname: X\ntype: feedback\nportable: true\ntags: []\n---\nbody\n`;
    const parsed = parseSeed(text);
    assert.deepEqual(parsed.tags, { language: [], testing: [], platform: [] });
  });

  it("returns null when there is no frontmatter", () => {
    assert.equal(parseSeed("just body\n"), null);
  });

  it("strips a UTF-8 BOM before parsing", () => {
    const text = `\ufeff---\nname: X\ntype: feedback\nportable: true\ntags: []\n---\nok\n`;
    const parsed = parseSeed(text);
    assert.equal(parsed.name, "X");
  });

  it("handles multi-value tag arrays", () => {
    const text = [
      "---",
      "name: y",
      "type: feedback",
      "portable: true",
      "tags:",
      "  language: swift",
      "  testing: xcuitest",
      "  platform: ios",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSeed(text);
    assert.deepEqual(parsed.tags.language, ["swift"]);
    assert.deepEqual(parsed.tags.testing, ["xcuitest"]);
    assert.deepEqual(parsed.tags.platform, ["ios"]);
  });
});

describe("install_memory_seeds.seedApplies", () => {
  const tagsSwiftXc = { language: ["swift"], testing: ["xcuitest"], platform: [] };
  const tagsEmpty = { language: [], testing: [], platform: [] };

  it("returns true when seed has no tag requirements", () => {
    const stack = collectStackTags({ language: [] });
    assert.equal(seedApplies(tagsEmpty, stack), true);
  });

  it("returns true only when EVERY required tag is present", () => {
    const swiftOnly = collectStackTags({ language: ["swift"], testing: [] });
    assert.equal(seedApplies(tagsSwiftXc, swiftOnly), false);

    const full = collectStackTags({ language: ["swift"], testing: ["xcuitest"] });
    assert.equal(seedApplies(tagsSwiftXc, full), true);
  });
});

describe("install_memory_seeds.formatTags", () => {
  it("renders a concise summary when tags are present", () => {
    const text = formatTags({ language: ["swift"], testing: ["xcuitest"], platform: [] });
    assert.match(text, /language=swift/);
    assert.match(text, /testing=xcuitest/);
  });

  it("says (no stack tags) when empty", () => {
    assert.equal(formatTags({ language: [], testing: [], platform: [] }), "(no stack tags)");
  });
});

describe("install_memory_seeds.slugifyFilename", () => {
  it("produces a valid filename slug", () => {
    assert.equal(slugifyFilename("DST-safe day counting (Swift)"), "dst-safe-day-counting-swift");
  });

  it("handles underscores and dots", () => {
    assert.equal(slugifyFilename("my_seed.v2"), "my_seed.v2");
  });
});

describe("install_memory_seeds.buildHeaderForMemory", () => {
  it("renders a valid frontmatter + include instruction", () => {
    const seed = { name: "Sample", description: "desc", type: "feedback" };
    const out = buildHeaderForMemory(seed, "bundle/memory-seeds/sample.md", "Wrapper notice.");
    assert.match(out, /^---\nname: \[seed\] Sample/m);
    assert.match(out, /bundle\/memory-seeds\/sample\.md/);
  });
});
