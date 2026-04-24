import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintCacheBlocks } from "../scripts/lint/require-cache-block.mjs";

describe("lint: require-cache-block", () => {
  it("all SKILL.md files pass the cache-control marker check", async () => {
    const { ok, results } = await lintCacheBlocks();
    const failures = results.filter((r) => r.status === "fail");
    if (failures.length > 0) {
      const msg = failures.map((f) => `${f.path}: ${f.problems.join("; ")}`).join("\n");
      assert.fail(`Cache-control lint failed:\n${msg}`);
    }
    assert.ok(ok);
  });

  it("at least one SKILL.md is above the threshold and checked", async () => {
    const { results } = await lintCacheBlocks();
    const checked = results.filter((r) => r.status === "pass" || r.status === "fail");
    assert.ok(checked.length > 0, "expected at least one non-exempt SKILL.md");
  });

  it("checked files have both static and dynamic markers in correct order", async () => {
    const { results } = await lintCacheBlocks();
    const checked = results.filter((r) => r.status === "pass" || r.status === "fail");
    for (const r of checked) {
      assert.equal(r.status, "pass", `${r.path} should pass: ${r.problems?.join("; ")}`);
    }
  });
});
