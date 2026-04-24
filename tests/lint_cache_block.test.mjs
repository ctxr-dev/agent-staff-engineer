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

  it("no warnings (every skill directory has a readable SKILL.md)", async () => {
    const { results } = await lintCacheBlocks();
    const warnings = results.filter((r) => r.status === "warn");
    assert.equal(warnings.length, 0, `unexpected warnings: ${JSON.stringify(warnings)}`);
  });

  it("checked files have both static and dynamic markers", async () => {
    const { results } = await lintCacheBlocks();
    const checked = results.filter((r) => r.status === "pass" || r.status === "fail");
    for (const r of checked) {
      assert.equal(r.status, "pass", `${r.path} should pass`);
    }
  });
});
