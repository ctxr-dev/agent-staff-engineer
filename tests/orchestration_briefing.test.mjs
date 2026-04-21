import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBriefing,
  templateFor,
  SHAPES,
  REQUIRED_VARS,
} from "../scripts/lib/orchestration/briefing.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = await readFile(
  join(__dirname, "..", "skills", "orchestrator", "SKILL.md"),
  "utf8",
);

describe("SHAPES + REQUIRED_VARS", () => {
  it("exposes the three documented Soldier shapes", () => {
    assert.deepEqual([...SHAPES], ["explorer", "implementer", "reviewer"]);
  });

  it("every shape has a non-empty required-var list", () => {
    for (const shape of SHAPES) {
      assert.ok(Array.isArray(REQUIRED_VARS[shape]), `${shape} missing REQUIRED_VARS`);
      assert.ok(REQUIRED_VARS[shape].length > 0, `${shape} REQUIRED_VARS is empty`);
    }
  });

  it("required-var lists match the placeholders in templateFor() output", () => {
    // Lock the briefing.mjs internal contract: if someone adds a
    // {{new_var}} to an in-code template they must bump REQUIRED_VARS
    // too. This is the FAST check; the drift-vs-SKILL.md check below
    // locks the cross-file contract.
    for (const shape of SHAPES) {
      const template = templateFor(shape);
      const placeholders = [...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]);
      const unique = [...new Set(placeholders)].sort();
      const declared = [...REQUIRED_VARS[shape]].sort();
      assert.deepEqual(unique, declared, `${shape} template placeholders do not match REQUIRED_VARS`);
    }
  });

  it("briefing.mjs templates match the canonical prose in skills/orchestrator/SKILL.md (no drift)", () => {
    // Parse the three fenced ```text blocks under "## Briefing
    // templates" in SKILL.md and compare them to templateFor(shape)
    // verbatim. Drift between the code and the doc means the Soldier
    // briefing the Captain sends differs from what the operator
    // reference describes; fail the test now rather than let the
    // divergence ship.
    const extractTextBlocks = (md) => {
      const re = /```text\n([\s\S]*?)```/g;
      const blocks = [];
      let match;
      while ((match = re.exec(md)) !== null) {
        // Trim a trailing newline introduced by the closing fence.
        blocks.push(match[1].replace(/\n$/, ""));
      }
      return blocks;
    };
    const blocks = extractTextBlocks(SKILL_MD);
    // The skill's "## Briefing templates" section documents the
    // three shapes in order: Explorer, Implementer, Reviewer.
    // Worked-example blocks come later in the same file and are
    // not templates, so we match on the opening sentence each
    // template starts with.
    const byShape = {};
    for (const block of blocks) {
      if (block.startsWith("You are an Explorer Soldier")) byShape.explorer = block;
      else if (block.startsWith("You are an Implementer Soldier")) byShape.implementer = block;
      else if (block.startsWith("You are a Reviewer Soldier")) byShape.reviewer = block;
    }
    for (const shape of SHAPES) {
      assert.ok(
        byShape[shape],
        `skills/orchestrator/SKILL.md is missing the ${shape} briefing block`,
      );
      assert.equal(
        templateFor(shape),
        byShape[shape],
        `${shape} template in briefing.mjs does not match skills/orchestrator/SKILL.md verbatim`,
      );
    }
  });
});

describe("buildBriefing: happy path", () => {
  it("fills every placeholder with the supplied var", () => {
    const out = buildBriefing("explorer", {
      task_description: "Survey the tracker layer.",
      scope_description: "scripts/lib/trackers/**.",
      out_of_scope: "Production gh CLI config.",
      starting_points: "grep -n 'Tracker' scripts/lib/trackers/tracker.mjs",
    });
    assert.ok(out.includes("Survey the tracker layer."));
    assert.ok(out.includes("scripts/lib/trackers/**."));
    assert.ok(out.includes("Production gh CLI config."));
    assert.ok(out.includes("grep -n 'Tracker' scripts/lib/trackers/tracker.mjs"));
    // No unfilled placeholders left.
    // Match the placeholder grammar used in briefing.mjs's extraction
    // regex ([a-zA-Z0-9_]+). A narrower check ([a-z_]+) would miss
    // mixed-case or digit-containing placeholders if the templates
    // ever grow them.
    assert.ok(!/\{\{[a-zA-Z0-9_]+\}\}/.test(out), "template still has unfilled {{ }}");
  });

  it("is deterministic for the same inputs", () => {
    const vars = {
      task_description: "t",
      file_scope: "s",
      acceptance_criteria: "a",
      verification_plan: "v",
    };
    const a = buildBriefing("implementer", vars);
    const b = buildBriefing("implementer", vars);
    assert.equal(a, b);
  });

  it("does not re-substitute placeholder-like tokens inside already-inserted var values", () => {
    // Regression: earlier impl used sequential split/join which would
    // re-scan inserted text on later iterations, so a task_description
    // that happened to contain "{{out_of_scope}}" would see that token
    // substituted by the out_of_scope value. Single-pass regex fix.
    const out = buildBriefing("explorer", {
      task_description: "Survey the behaviour of {{out_of_scope}} placeholders in test fixtures.",
      scope_description: "tests/fixtures/**.",
      out_of_scope: "REPLACED-SHOULD-NOT-APPEAR-IN-TASK",
      starting_points: "grep -n 'fixture' tests/fixtures.",
    });
    // task_description's literal `{{out_of_scope}}` must pass through
    // unchanged; the out_of_scope value must appear ONLY in the
    // out_of_scope slot.
    assert.ok(
      out.includes("Survey the behaviour of {{out_of_scope}} placeholders"),
      "task_description's literal {{out_of_scope}} was not preserved verbatim",
    );
    assert.equal(
      out.split("REPLACED-SHOULD-NOT-APPEAR-IN-TASK").length - 1,
      1,
      "out_of_scope value was injected more than once (re-substitution regression)",
    );
  });

  it("preserves special regex characters in var values (no substitution surprises)", () => {
    const out = buildBriefing("reviewer", {
      task_description: "Check the $1 placeholder in log lines.",
      review_scope: "Every grep alternation like `.*\\nError.*`.",
      rubric: "`$NODE_OPTIONS=--enable-source-maps` must stay set.",
      out_of_scope: "Docs (.md) files.",
    });
    assert.ok(out.includes("$1 placeholder"), "dollar-digit ran through");
    assert.ok(out.includes(".*\\nError.*"), "regex literal preserved");
    assert.ok(out.includes("$NODE_OPTIONS=--enable-source-maps"), "dollar-env preserved");
  });
});

describe("buildBriefing: validation", () => {
  it("rejects an unknown shape", () => {
    assert.throws(
      () => buildBriefing("guardian", {}),
      /shape must be one of/,
    );
  });

  it("rejects non-object vars", () => {
    assert.throws(() => buildBriefing("explorer", null), /vars must be a plain object/);
    assert.throws(() => buildBriefing("explorer", []), /vars must be a plain object/);
    assert.throws(() => buildBriefing("explorer", "string"), /vars must be a plain object/);
  });

  it("rejects missing required vars (names them in the error)", () => {
    assert.throws(
      () => buildBriefing("explorer", { task_description: "t" }),
      /missing required vars \[scope_description, out_of_scope, starting_points\]/,
    );
  });

  it("rejects extra vars not in the required list", () => {
    assert.throws(
      () =>
        buildBriefing("explorer", {
          task_description: "t",
          scope_description: "s",
          out_of_scope: "o",
          starting_points: "p",
          something_extra: "x",
        }),
      /unknown vars \[something_extra\]/,
    );
  });

  it("rejects empty / whitespace-only var values", () => {
    assert.throws(
      () =>
        buildBriefing("explorer", {
          task_description: "   ",
          scope_description: "s",
          out_of_scope: "o",
          starting_points: "p",
        }),
      /var 'task_description' must be a non-empty string/,
    );
    assert.throws(
      () =>
        buildBriefing("explorer", {
          task_description: "t",
          scope_description: null,
          out_of_scope: "o",
          starting_points: "p",
        }),
      /var 'scope_description' must be a non-empty string/,
    );
  });
});

describe("templateFor", () => {
  it("returns the raw template string (includes placeholders)", () => {
    const t = templateFor("implementer");
    assert.ok(t.includes("{{task_description}}"));
    assert.ok(t.includes("{{file_scope}}"));
  });

  it("rejects unknown shapes", () => {
    assert.throws(() => templateFor("guardian"), /shape must be one of/);
  });
});
