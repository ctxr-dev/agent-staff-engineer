import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNode, installGuidance, MIN_NODE_MAJOR } from "../scripts/preflight.mjs";

describe("preflight.detectNode", () => {
  it("returns the expected shape", () => {
    const d = detectNode();
    assert.equal(typeof d.ok, "boolean");
    assert.equal(typeof d.currentMajor, "number");
    assert.equal(typeof d.current, "string");
    assert.equal(d.required, MIN_NODE_MAJOR);
    assert.ok(["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix"].includes(d.platform));
  });
  it("reports ok=true on the current runtime (test runner requires >= 20)", () => {
    const d = detectNode();
    assert.equal(d.ok, true);
  });
});

describe("preflight.installGuidance", () => {
  it("returns non-empty strings for supported platforms", () => {
    for (const p of ["darwin", "linux", "win32"]) {
      const g = installGuidance(p);
      assert.ok(typeof g === "string" && g.length > 20, `guidance for ${p} looks empty`);
    }
  });
  it("handles unknown platforms gracefully", () => {
    const g = installGuidance("beos");
    assert.ok(g.includes("Node"));
    assert.ok(g.includes(String(MIN_NODE_MAJOR)));
  });
});
