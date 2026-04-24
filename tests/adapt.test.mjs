import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  dedupeSignals,
  applySignalToConfig,
  buildNonConfigPlan,
  diffArray,
} from "../scripts/adapt.mjs";
import { CODE_REVIEW_SKILL, CODE_REVIEW_INTERNAL, CODE_REVIEW_NONE } from "../scripts/lib/constants.mjs";

describe("adapt.classify", () => {
  it("detects explicit compliance regimes at word boundaries", () => {
    const sigs = classify("we handle HIPAA now");
    assert.ok(sigs.some((s) => s.kind === "compliance:add" && s.value === "hipaa"));
  });

  it("does not fire for substring matches (pci inside pcie)", () => {
    const sigs = classify("the pcie bus is full");
    assert.ok(!sigs.some((s) => s.kind === "compliance:add" && s.value === "pci"));
  });

  it("does not fire stack:add:language for 'go' inside 'going'", () => {
    const sigs = classify("we're going to refactor the auth layer");
    assert.ok(!sigs.some((s) => s.kind === "stack:add:language" && s.value === "go"));
  });

  it("detects 'we added a chrome-extension target' as a platform add", () => {
    const sigs = classify("we added a chrome-extension target");
    assert.ok(sigs.some((s) => s.kind === "stack:add:platform" && s.value === "chrome-extension"));
  });

  it("does NOT fire cadence:set for unrelated 'v14' mention", () => {
    const sigs = classify("we upgraded to macOS v14 on CI runners");
    assert.ok(!sigs.some((s) => s.kind === "cadence:set"));
  });

  it("detects explicit cadence phrases", () => {
    const sigs = classify("we're moving to continuous delivery");
    assert.ok(sigs.some((s) => s.kind === "cadence:set" && s.value === "continuous"));
  });

  it("detects code-review switch intents", () => {
    assert.ok(classify("switch code-review provider to internal-template").some(
      (s) => s.kind === "code-review:switch" && s.value === CODE_REVIEW_INTERNAL,
    ));
    assert.ok(classify("use external code review").some(
      (s) => s.kind === "code-review:switch" && s.value === CODE_REVIEW_SKILL,
    ));
    assert.ok(classify("disable code review").some(
      (s) => s.kind === "code-review:switch" && s.value === CODE_REVIEW_NONE,
    ));
  });

  it("detects drop intent separately from add", () => {
    const sigs = classify("drop gdpr, not applicable");
    assert.ok(sigs.some((s) => s.kind === "compliance:drop" && s.value === "gdpr"));
  });

  it("returns empty signals for pure prose with no shape-changing intent", () => {
    assert.deepEqual(classify("please update the dashboard"), []);
  });
});

describe("adapt.dedupeSignals", () => {
  it("removes duplicate kind+value pairs", () => {
    const out = dedupeSignals([
      { kind: "compliance:add", value: "hipaa" },
      { kind: "compliance:add", value: "hipaa" },
      { kind: "compliance:add", value: "gdpr" },
    ]);
    assert.equal(out.length, 2);
  });
});

describe("adapt.applySignalToConfig", () => {
  const fresh = () => ({
    compliance: { regimes: ["none"], data_classes: ["none"] },
    stack: { language: [], testing: [], platform: [] },
    labels: { area: [] },
  });

  it("adds compliance regime and strips 'none'", () => {
    const cfg = fresh();
    const log = [];
    applySignalToConfig(cfg, { kind: "compliance:add", value: "hipaa" }, log);
    assert.ok(cfg.compliance.regimes.includes("hipaa"));
    assert.ok(!cfg.compliance.regimes.includes("none"));
    assert.ok(cfg.labels.area.includes("compliance-hipaa"));
    assert.equal(log.length, 1);
  });

  it("is idempotent on repeated add", () => {
    const cfg = fresh();
    applySignalToConfig(cfg, { kind: "compliance:add", value: "hipaa" }, []);
    applySignalToConfig(cfg, { kind: "compliance:add", value: "hipaa" }, []);
    assert.equal(cfg.compliance.regimes.filter((r) => r === "hipaa").length, 1);
  });

  it("adds a stack tag on stack:add:<axis>", () => {
    const cfg = fresh();
    const log = [];
    applySignalToConfig(cfg, { kind: "stack:add:language", value: "swift" }, log);
    assert.deepEqual(cfg.stack.language, ["swift"]);
    assert.equal(log.length, 1);
  });

  it("code-review:switch updates workflow.code_review.provider", () => {
    const cfg = { workflow: { code_review: { provider: CODE_REVIEW_SKILL } } };
    const log = [];
    applySignalToConfig(cfg, { kind: "code-review:switch", value: CODE_REVIEW_INTERNAL }, log);
    assert.equal(cfg.workflow.code_review.provider, CODE_REVIEW_INTERNAL);
    assert.equal(log.length, 1);
    assert.match(log[0], new RegExp(CODE_REVIEW_INTERNAL));
  });

  it("cadence:set flips phase_term to 'track' for continuous", () => {
    const cfg = { workflow: { phase_term: "wave" } };
    applySignalToConfig(cfg, { kind: "cadence:set", value: "continuous" }, []);
    assert.equal(cfg.workflow.phase_term, "track");
  });

  it("cadence:set produces 'version' for per-version", () => {
    const cfg = { workflow: { phase_term: "wave" } };
    applySignalToConfig(cfg, { kind: "cadence:set", value: "per-version" }, []);
    assert.equal(cfg.workflow.phase_term, "version");
  });
});

describe("adapt.diffArray", () => {
  it("computes added and removed sets", () => {
    const { added, removed } = diffArray(["a", "b"], ["b", "c"]);
    assert.deepEqual(added, ["c"]);
    assert.deepEqual(removed, ["a"]);
  });
});

describe("adapt.buildNonConfigPlan", () => {
  it("proposes label create when area list grows", () => {
    const before = { labels: { area: ["backend"] }, stack: { language: ["typescript"] } };
    const after = { labels: { area: ["backend", "phi"] }, stack: { language: ["typescript"] } };
    const plan = buildNonConfigPlan([], before, after);
    assert.ok(plan.some((s) => s.includes("create labels area/phi")));
  });

  it("proposes seed install when stack grows", () => {
    const before = { labels: { area: [] }, stack: { language: [] } };
    const after = { labels: { area: [] }, stack: { language: ["swift"] } };
    const plan = buildNonConfigPlan([], before, after);
    assert.ok(plan.some((s) => s.includes("install_memory_seeds")));
  });
});
