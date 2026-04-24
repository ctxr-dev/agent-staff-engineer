import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintCacheBlocks } from "../scripts/lint/require-cache-block.mjs";

describe("lint: require-cache-block", () => {
  it("all SKILL.md files pass the cache-control marker check", async () => {
    const { ok, results } = await lintCacheBlocks();
    const failures = results.filter((r) => r.status === "fail");
    if (failures.length > 0) {
      const msg = failures.map((f) => `${f.path}: missing ${f.missing.join(", ")}`).join("\n");
      assert.fail(`Cache-control lint failed:\n${msg}`);
    }
    assert.ok(ok);
  });

  it("every non-exempt SKILL.md has both static and dynamic markers", async () => {
    const { results } = await lintCacheBlocks();
    const checked = results.filter((r) => r.status !== "exempt");
    assert.ok(checked.length > 0, "expected at least one SKILL.md above the threshold");
    for (const r of checked) {
      assert.equal(r.status, "pass", `${r.path} should pass`);
    }
  });
});
