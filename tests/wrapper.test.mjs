import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeWrapper, splitAtMarker } from "../scripts/lib/wrapper.mjs";

const MARKER = "<!-- ==== OVERRIDES BELOW ==== -->";

describe("mergeWrapper: fresh install", () => {
  it("returns above + marker + blank line when no existing content", () => {
    const result = mergeWrapper(null, "frontmatter\nbody\n", MARKER);
    assert.match(result, /frontmatter\nbody\n<!-- ==== OVERRIDES BELOW ==== -->\n\n$/);
  });

  it("normalises above-marker trailing whitespace", () => {
    const a = mergeWrapper(null, "body\n\n\n\n", MARKER);
    const b = mergeWrapper(null, "body", MARKER);
    assert.equal(a, b, "trailing-newline drift should not produce different output");
  });
});

describe("mergeWrapper: update path", () => {
  it("preserves below-marker content byte-for-byte across a refresh", () => {
    const existing = `old above\n${MARKER}\n\nUser override line\nAnother line\n`;
    const fresh = mergeWrapper(existing, "new above\n", MARKER);
    assert.ok(fresh.startsWith("new above\n"));
    assert.ok(fresh.endsWith("User override line\nAnother line\n"));
  });

  it("preserves user content even when the user pastes the marker string again below", () => {
    // The real marker is the first one (written by the installer). Any
    // subsequent occurrence inside user overrides must be preserved as-is.
    const existing = `old above\n${MARKER}\nuser text line 1\n${MARKER}\nuser text line 2\n`;
    const fresh = mergeWrapper(existing, "new above\n", MARKER);
    // Everything after the FIRST marker in the refreshed output is below-marker.
    // Both "user text line 1" and "user text line 2" must be present.
    const firstIdx = fresh.indexOf(MARKER);
    const below = fresh.slice(firstIdx + MARKER.length);
    assert.match(below, /user text line 1/);
    assert.match(below, /user text line 2/);
    // And the pasted marker itself is preserved inside the below section.
    assert.ok(below.includes(MARKER), "pasted marker string should survive in user overrides");
  });
});

describe("mergeWrapper: marker-less existing wrappers", () => {
  it("preserves the full existing content and inserts a warning", () => {
    const existing = "legacy file without marker\nexpensive-to-lose lines\n";
    const fresh = mergeWrapper(existing, "new above\n", MARKER);
    assert.match(fresh, /expensive-to-lose lines/);
    assert.match(fresh, /had no marker/);
  });
});

describe("splitAtMarker", () => {
  it("returns { above, below } halves split on the last marker", () => {
    const content = `header\n${MARKER}\noverrides\n`;
    const { above, below } = splitAtMarker(content, MARKER);
    assert.equal(above, "header\n");
    assert.equal(below, "\noverrides\n");
  });

  it("returns nulls when marker is absent", () => {
    assert.deepEqual(splitAtMarker("no marker here", MARKER), { above: null, below: null });
  });
});
