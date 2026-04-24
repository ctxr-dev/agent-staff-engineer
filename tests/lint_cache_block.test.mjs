import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintCacheBlocks } from "../scripts/lint/require-cache-block.mjs";

describe("lint: require-cache-block", () => {
  let lintResult;

  before(async () => {
    lintResult = await lintCacheBlocks();
  });

  it("all SKILL.md files pass the cache-control marker check", () => {
    const failures = lintResult.results.filter((r) => r.status === "fail");
    if (failures.length > 0) {
      const msg = failures.map((f) => `${f.path}: ${f.problems.join("; ")}`).join("\n");
      assert.fail(`Cache-control lint failed:\n${msg}`);
    }
    assert.ok(lintResult.ok);
  });

  it("checked files have both static and dynamic markers in correct order", () => {
    const checked = lintResult.results.filter((r) => r.status === "pass" || r.status === "fail");
    for (const r of checked) {
      assert.equal(r.status, "pass", `${r.path} should pass: ${r.problems?.join("; ")}`);
    }
  });
});
