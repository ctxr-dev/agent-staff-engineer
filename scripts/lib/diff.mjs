// lib/diff.mjs
// Line-based unified diff backed by the `diff` npm package (jsdiff).
// Replaces a hand-rolled LCS + hunk-collector that had documented off-by-ones
// in hunk headers and a useless "summarised" fallback on inputs larger than
// ~800 lines.
//
// Public API is preserved: `diffLines(a, b, { labelA, labelB, context })`
// returns a unified-diff string, or `""` when the two inputs are identical.

import { createPatch } from "diff";

export function diffLines(a, b, options = {}) {
  const labelA = options.labelA ?? "before";
  const labelB = options.labelB ?? "after";
  const context = options.context ?? 2;

  const norm = (s) => (s == null ? "" : String(s).replace(/\r\n/g, "\n"));
  const left = norm(a);
  const right = norm(b);
  if (left === right) return "";

  // createPatch produces: --- label\n+++ label\n@@ hunk @@\n...\n
  // Passing "" for oldHeader and newHeader keeps the output clean (without
  // date/time annotations that the caller doesn't need).
  const patch = createPatch(`${labelB}`, left, right, "", "", { context });
  // createPatch emits `Index:` + `===` preamble lines. Strip them so the
  // output matches the shape callers (and tests) already expect.
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("Index: ") && !/^=+$/.test(line))
    .join("\n")
    .replace(/^--- \n/, `--- ${labelA}\n`); // jsdiff uses the second arg as header; replace first label
}
