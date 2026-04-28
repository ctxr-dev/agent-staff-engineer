import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectManagedBlock, removeManagedBlock } from "../scripts/lib/inject.mjs";

const BEGIN = "<!-- agent:begin -->";
const END = "<!-- agent:end -->";
const M = { begin: BEGIN, end: END };

describe("inject.injectManagedBlock: file missing", () => {
  it("creates a new file with optional preamble + managed block", () => {
    const out = injectManagedBlock(null, "hello\n", { ...M, preamble: "# Title" });
    assert.match(out, /^# Title\n\n<!-- agent:begin -->\nhello\n<!-- agent:end -->\n$/);
  });
  it("treats empty string as missing", () => {
    const out = injectManagedBlock("", "hello\n", M);
    assert.match(out, /^<!-- agent:begin -->\nhello\n<!-- agent:end -->\n$/);
  });
});

describe("inject.injectManagedBlock: pre-existing without markers", () => {
  it("appends the block after existing content with a blank-line separator", () => {
    const existing = "# Project\n\nSome prose by the user.\n";
    const out = injectManagedBlock(existing, "managed content\n", M);
    assert.ok(out.startsWith("# Project\n\nSome prose by the user.\n"), "user content preserved at top");
    assert.ok(out.endsWith("<!-- agent:end -->\n"), "block appended at end");
    assert.match(out, /Some prose by the user\.\n\n<!-- agent:begin -->/, "blank-line separator inserted");
  });

  it("appends cleanly when existing file has no trailing newline", () => {
    const existing = "no newline at end";
    const out = injectManagedBlock(existing, "managed\n", M);
    assert.ok(out.startsWith("no newline at end\n"));
    assert.ok(out.includes(BEGIN));
  });
});

describe("inject.injectManagedBlock: refresh existing managed block", () => {
  it("replaces only between markers; preserves outside bytes verbatim", () => {
    const existing = [
      "# Project",
      "",
      "User preamble.",
      "",
      BEGIN,
      "OLD managed content",
      END,
      "",
      "User postscript.",
      "",
    ].join("\n");
    const out = injectManagedBlock(existing, "NEW managed content\n", M);
    assert.ok(out.includes("User preamble."));
    assert.ok(out.includes("User postscript."));
    assert.ok(out.includes("NEW managed content"));
    assert.ok(!out.includes("OLD managed content"));
  });

  it("is byte-stable on no-op refresh (same content in, same content out)", () => {
    const first = injectManagedBlock(null, "stable\n", { ...M, preamble: "# Head" });
    const second = injectManagedBlock(first, "stable\n", { ...M, preamble: "# Head" });
    assert.equal(second, first);
  });

  it("throws when begin is present but end is absent (refuses to guess)", () => {
    const existing = `preamble\n${BEGIN}\nbody\nno-end\n`;
    assert.throws(() => injectManagedBlock(existing, "x\n", M), /end marker/i);
  });
});

describe("inject.removeManagedBlock", () => {
  it("removes the block, leaving surrounding bytes intact", () => {
    const existing = [
      "# Project",
      "",
      "User preamble.",
      "",
      BEGIN,
      "managed body",
      END,
      "",
      "User postscript.",
      "",
    ].join("\n");
    const out = removeManagedBlock(existing, M);
    assert.ok(out.includes("User preamble."));
    assert.ok(out.includes("User postscript."));
    assert.ok(!out.includes(BEGIN));
    assert.ok(!out.includes(END));
    assert.ok(!out.includes("managed body"));
  });

  it("returns the original content when no markers are present", () => {
    const existing = "just user text\n";
    assert.equal(removeManagedBlock(existing, M), existing);
  });

  it("handles a file that is exactly the block + nothing else", () => {
    const only = `${BEGIN}\nbody\n${END}\n`;
    const out = removeManagedBlock(only, M);
    assert.equal(out, "");
  });
});

describe("inject: adversarial inputs (BOM, CRLF, markers-moved)", () => {
  it("handles a UTF-8 BOM before the begin marker (no duplicate append on refresh)", () => {
    const existing = `\uFEFF${BEGIN}\nold\n${END}\n`;
    const out = injectManagedBlock(existing, "new\n", M);
    const matches = out.split(BEGIN).length - 1;
    assert.equal(matches, 1, "BOM must not cause a duplicate injection");
    assert.ok(out.includes("new"));
    assert.ok(!out.includes("old"));
  });

  it("preserves a leading UTF-8 BOM byte-for-byte on refresh", () => {
    const existing = `\uFEFF${BEGIN}\nold\n${END}\n`;
    const out = injectManagedBlock(existing, "new\n", M);
    assert.equal(out.charCodeAt(0), 0xfeff, "BOM must survive the refresh");
  });

  it("finds markers wherever the user moved them in the file", () => {
    const existing = [
      "Some lines above",
      "Even more prose",
      BEGIN,
      "managed",
      END,
      "Trailing user content",
    ].join("\n");
    const out = injectManagedBlock(existing, "refreshed\n", M);
    assert.ok(out.includes("Some lines above"));
    assert.ok(out.includes("refreshed"));
    assert.ok(out.includes("Trailing user content"));
    assert.ok(!out.includes("\nmanaged\n")); // the old inner content gone
  });

  it("removeManagedBlock is tolerant of a dangling begin-without-end", () => {
    const existing = `head\n${BEGIN}\nhalf\n`;
    assert.equal(removeManagedBlock(existing, M), existing, "dangling begin should be left alone");
  });

  it("removeManagedBlock preserves a leading UTF-8 BOM", () => {
    // The BOM-tolerant findLineContaining lets the begin marker land
    // at offset 1 when the file opens with \uFEFF; without explicit
    // BOM-preserve logic, slice(0, 0) silently drops the BOM and the
    // byte-for-byte preservation contract breaks.
    const existing = `\uFEFF${BEGIN}\ninner\n${END}\nuser tail\n`;
    const out = removeManagedBlock(existing, M);
    assert.equal(out.charCodeAt(0), 0xfeff, "BOM must survive uninstall");
    assert.ok(out.includes("user tail"));
    assert.ok(!out.includes(BEGIN));
    assert.ok(!out.includes(END));
  });

  it("removeManagedBlock on a CRLF file leaves no stray \\r at the join", () => {
    // `/\n+$/` and `/^\n+/` (the round-14 regexes) only stripped
    // bare LFs; on a CRLF file each surviving line still ended with
    // `\r\n`, but the trailing `\r` immediately before the begin
    // marker (and the leading one after the end) survived the trim,
    // producing a `\r\n\r\n` join with a stray `\r` orphaned at the
    // boundary. The `\r?` guard now matches both forms; assert
    // there is no isolated CR adjacent to LF anywhere in the output.
    const lines = [
      "# Project",
      "",
      "User preamble.",
      "",
      BEGIN,
      "managed body",
      END,
      "",
      "User postscript.",
      "",
    ];
    const existing = lines.join("\r\n");
    const out = removeManagedBlock(existing, M);
    assert.ok(out.includes("User preamble."));
    assert.ok(out.includes("User postscript."));
    // Every \r in the output must be immediately followed by \n
    // (proper CRLF). A bare \r (followed by anything else, or EOF)
    // is the regression we are guarding against.
    for (let i = 0; i < out.length; i++) {
      if (out.charCodeAt(i) === 0x0d) {
        assert.equal(
          out.charCodeAt(i + 1),
          0x0a,
          `stray \\r at offset ${i}: ${JSON.stringify(out.slice(Math.max(0, i - 4), i + 6))}`,
        );
      }
    }
    // Separator between the two preserved halves is CRLF\r\nCRLF,
    // matching the file's prevailing EOL.
    assert.match(out, /User preamble\.\r\n\r\nUser postscript\./);
  });

  it("removeManagedBlock on a CRLF file preserves a single CRLF when only one side has user content", () => {
    // before-only branch (after === ""): out should end with one CRLF.
    const before = ["head", "", BEGIN, "x", END, ""].join("\r\n");
    const outBefore = removeManagedBlock(before, M);
    assert.equal(outBefore, "head\r\n");
    // after-only branch (before === ""): out should start with the
    // user's content and have no leading CRLF run.
    const after = [BEGIN, "x", END, "", "tail", ""].join("\r\n");
    const outAfter = removeManagedBlock(after, M);
    assert.equal(outAfter, "tail\r\n");
  });
});

describe("inject: marker validation", () => {
  it("rejects empty markers", () => {
    assert.throws(() => injectManagedBlock(null, "x", { begin: "", end: "y" }));
    assert.throws(() => injectManagedBlock(null, "x", { begin: "y", end: "" }));
  });
  it("rejects identical begin and end", () => {
    assert.throws(() => injectManagedBlock(null, "x", { begin: "same", end: "same" }));
  });
  it("rejects multi-line markers", () => {
    assert.throws(() => injectManagedBlock(null, "x", { begin: "a\nb", end: "c" }));
  });
});
