import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../scripts/lib/diff.mjs";

describe("diff.diffLines", () => {
  it("returns empty string for identical input", () => {
    assert.equal(diffLines("hello", "hello"), "");
  });

  it("treats null and empty string identically", () => {
    assert.equal(diffLines(null, ""), "");
    assert.equal(diffLines("", null), "");
  });

  it("normalises CRLF to LF so Windows checkouts do not diff as garbage", () => {
    const lf = "a\nb\nc";
    const crlf = "a\r\nb\r\nc";
    assert.equal(diffLines(lf, crlf), "");
  });

  it("marks added lines with + and removed lines with -", () => {
    const out = diffLines("a\nb", "a\nc");
    assert.match(out, /^---/m);
    assert.match(out, /^\+\+\+/m);
    assert.match(out, /^-b/m);
    assert.match(out, /^\+c/m);
  });

  it("emits a header for the actual first hunk", () => {
    const out = diffLines("a\nb\nc", "a\nX\nc");
    assert.match(out, /@@ -/);
  });
});
