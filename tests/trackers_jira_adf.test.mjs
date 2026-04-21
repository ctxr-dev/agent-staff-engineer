import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { markdownToAdf, plainTextToAdf } from "../scripts/lib/trackers/jira-adf.mjs";

// ── Document shape ──────────────────────────────────────────────────

describe("markdownToAdf: document root", () => {
  it("returns a minimal valid ADF doc for empty input", () => {
    assert.deepEqual(markdownToAdf(""), { type: "doc", version: 1, content: [] });
  });

  it("returns a doc with one paragraph for a single line", () => {
    const out = markdownToAdf("Hello world");
    assert.equal(out.type, "doc");
    assert.equal(out.version, 1);
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, "paragraph");
    assert.equal(out.content[0].content[0].text, "Hello world");
  });

  it("throws on non-string input", () => {
    assert.throws(() => markdownToAdf(null), /must be a string/);
    assert.throws(() => markdownToAdf(123), /must be a string/);
  });
});

describe("plainTextToAdf", () => {
  it("wraps text in a single paragraph without parsing markdown syntax", () => {
    const out = plainTextToAdf("**not bold**");
    assert.equal(out.content[0].type, "paragraph");
    assert.equal(out.content[0].content[0].text, "**not bold**");
    assert.ok(!out.content[0].content[0].marks);
  });

  it("returns an empty doc for whitespace-only input", () => {
    assert.deepEqual(plainTextToAdf("   \n  \n"), { type: "doc", version: 1, content: [] });
  });
});

// ── Block-level parsing ─────────────────────────────────────────────

describe("markdownToAdf: headings", () => {
  it("supports levels 1 through 6", () => {
    for (let level = 1; level <= 6; level++) {
      const md = `${"#".repeat(level)} Heading ${level}`;
      const out = markdownToAdf(md);
      assert.equal(out.content[0].type, "heading");
      assert.equal(out.content[0].attrs.level, level);
      assert.equal(out.content[0].content[0].text, `Heading ${level}`);
    }
  });

  it("ignores trailing hashes", () => {
    const out = markdownToAdf("## Intro ###");
    assert.equal(out.content[0].content[0].text, "Intro");
  });
});

describe("markdownToAdf: lists", () => {
  it("parses a bullet list", () => {
    const out = markdownToAdf("- one\n- two\n- three");
    assert.equal(out.content[0].type, "bulletList");
    assert.equal(out.content[0].content.length, 3);
    assert.equal(out.content[0].content[0].type, "listItem");
    assert.equal(out.content[0].content[0].content[0].content[0].text, "one");
  });

  it("parses an ordered list and captures non-1 start", () => {
    const out = markdownToAdf("3. first\n4. second");
    assert.equal(out.content[0].type, "orderedList");
    assert.equal(out.content[0].attrs.order, 3);
    assert.equal(out.content[0].content[0].content[0].content[0].text, "first");
  });

  it("ends list on a blank line", () => {
    const out = markdownToAdf("- one\n\nregular paragraph");
    assert.equal(out.content[0].type, "bulletList");
    assert.equal(out.content[1].type, "paragraph");
    assert.equal(out.content[1].content[0].text, "regular paragraph");
  });
});

describe("markdownToAdf: code blocks", () => {
  it("parses a fenced block with language", () => {
    const md = "```js\nconsole.log(1)\n```";
    const out = markdownToAdf(md);
    assert.equal(out.content[0].type, "codeBlock");
    assert.equal(out.content[0].attrs.language, "js");
    assert.equal(out.content[0].content[0].text, "console.log(1)");
  });

  it("parses a fenced block without language", () => {
    const md = "```\nplain\nblock\n```";
    const out = markdownToAdf(md);
    assert.equal(out.content[0].type, "codeBlock");
    assert.ok(!out.content[0].attrs);
    assert.equal(out.content[0].content[0].text, "plain\nblock");
  });

  it("does NOT interpret markdown inside the block", () => {
    const md = "```\n**not bold**\n```";
    const out = markdownToAdf(md);
    assert.equal(out.content[0].content[0].text, "**not bold**");
    assert.ok(!out.content[0].content[0].marks);
  });
});

describe("markdownToAdf: blockquote", () => {
  it("wraps quoted lines in a blockquote+paragraph", () => {
    const out = markdownToAdf("> a quote\n> continues");
    assert.equal(out.content[0].type, "blockquote");
    assert.equal(out.content[0].content[0].type, "paragraph");
    assert.equal(out.content[0].content[0].content[0].text, "a quote continues");
  });
});

describe("markdownToAdf: thematic break", () => {
  it("maps --- to a rule node", () => {
    const out = markdownToAdf("paragraph\n\n---\n\nafter");
    assert.equal(out.content[1].type, "rule");
  });

  it("also maps *** and ___ to rule nodes", () => {
    const starRule = markdownToAdf("p\n\n***\n\nq");
    assert.equal(starRule.content[1].type, "rule");
    const underRule = markdownToAdf("p\n\n___\n\nq");
    assert.equal(underRule.content[1].type, "rule");
  });
});

describe("markdownToAdf: bullet list markers", () => {
  it("accepts `+` as a bullet marker alongside `-` and `*`", () => {
    const out = markdownToAdf("+ one\n+ two");
    assert.equal(out.content[0].type, "bulletList");
    assert.equal(out.content[0].content.length, 2);
    assert.equal(out.content[0].content[0].content[0].content[0].text, "one");
  });
});

// ── Inline marks ────────────────────────────────────────────────────

describe("markdownToAdf: inline marks", () => {
  function paragraphContent(md) {
    const out = markdownToAdf(md);
    return out.content[0].content;
  }

  it("parses bold with **", () => {
    const c = paragraphContent("a **bold** text");
    assert.equal(c[0].text, "a ");
    assert.equal(c[1].text, "bold");
    assert.deepEqual(c[1].marks, [{ type: "strong" }]);
    assert.equal(c[2].text, " text");
  });

  it("parses italic with *", () => {
    const c = paragraphContent("a *it* b");
    assert.equal(c[1].text, "it");
    assert.deepEqual(c[1].marks, [{ type: "em" }]);
  });

  it("does not confuse ** with *", () => {
    const c = paragraphContent("**bold** and *em*");
    assert.equal(c[0].text, "bold");
    assert.deepEqual(c[0].marks, [{ type: "strong" }]);
    assert.equal(c[2].text, "em");
    assert.deepEqual(c[2].marks, [{ type: "em" }]);
  });

  it("parses inline code", () => {
    const c = paragraphContent("a `x` b");
    assert.equal(c[1].text, "x");
    assert.deepEqual(c[1].marks, [{ type: "code" }]);
  });

  it("parses strikethrough with ~~", () => {
    const c = paragraphContent("a ~~gone~~ b");
    assert.equal(c[1].text, "gone");
    assert.deepEqual(c[1].marks, [{ type: "strike" }]);
  });

  it("parses link with href", () => {
    const c = paragraphContent("see [docs](https://example.com/x)");
    assert.equal(c[1].text, "docs");
    assert.deepEqual(c[1].marks, [
      { type: "link", attrs: { href: "https://example.com/x" } },
    ]);
  });

  it("nests marks: bold link text", () => {
    const c = paragraphContent("**[site](https://a.test)**");
    // Expect inner text to carry BOTH strong + link marks
    const inner = c[0];
    assert.equal(inner.text, "site");
    const markTypes = inner.marks.map((m) => m.type).sort();
    assert.deepEqual(markTypes, ["link", "strong"]);
  });

  it("emits hardBreak for two trailing spaces before newline", () => {
    const out = markdownToAdf("first  \nsecond");
    const paraContent = out.content[0].content;
    const hb = paraContent.find((n) => n.type === "hardBreak");
    assert.ok(hb, "expected hardBreak inline node");
  });

  it("preserves literal U+E000 codepoints in user input (no sentinel collision)", () => {
    // The previous implementation split on U+E000 internally and would
    // drop a real U+E000 from the user's input. The walker approach
    // makes no such assumption.
    const out = markdownToAdf("ab");
    const paraContent = out.content[0].content;
    const flat = paraContent.map((n) => (n.type === "text" ? n.text : `<${n.type}>`)).join("");
    assert.equal(flat, "ab");
    assert.ok(!paraContent.some((n) => n.type === "hardBreak"));
  });
});

describe("markdownToAdf: whole document", () => {
  it("handles a mixed document", () => {
    const md = [
      "# Title",
      "",
      "A **bold** intro with `code` and a [link](https://x.test).",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "export const x = 1;",
      "```",
      "",
      "> quote me",
      "",
      "tail paragraph",
    ].join("\n");
    const out = markdownToAdf(md);
    const types = out.content.map((n) => n.type);
    assert.deepEqual(types, [
      "heading",
      "paragraph",
      "bulletList",
      "codeBlock",
      "blockquote",
      "paragraph",
    ]);
  });

  it("normalises CRLF and CR line endings", () => {
    const out1 = markdownToAdf("a\r\nb");
    const out2 = markdownToAdf("a\rb");
    const out3 = markdownToAdf("a\nb");
    assert.deepEqual(out1, out3);
    assert.deepEqual(out2, out3);
  });
});
