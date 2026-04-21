import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DECISION_TREE,
  scoreArea,
  rankIssuesForShortlist,
} from "../scripts/lib/issueDiscovery.mjs";

describe("DECISION_TREE: shape + invariants", () => {
  const nodes = Object.values(DECISION_TREE);
  const ids = new Set(nodes.map((n) => n.id));

  it("every node declares id, predecessors, next, minOptions, maxOptions, canHalt, customEscape", () => {
    for (const node of nodes) {
      assert.ok(typeof node.id === "string", `node missing id: ${JSON.stringify(node)}`);
      assert.ok(Array.isArray(node.predecessors), `${node.id} missing predecessors array`);
      assert.ok(Array.isArray(node.next), `${node.id} missing next array`);
      assert.ok("minOptions" in node, `${node.id} missing minOptions`);
      assert.ok("maxOptions" in node, `${node.id} missing maxOptions`);
      assert.equal(typeof node.canHalt, "boolean", `${node.id} canHalt must be boolean`);
      assert.equal(typeof node.customEscape, "boolean", `${node.id} customEscape must be boolean`);
    }
  });

  it("ENTRY is the only node with empty predecessors", () => {
    const zeroPreds = nodes.filter((n) => n.predecessors.length === 0);
    assert.deepEqual(zeroPreds.map((n) => n.id).sort(), ["ENTRY"]);
  });

  it("every `next` target is either EXIT or a known node id", () => {
    for (const node of nodes) {
      for (const branch of node.next) {
        assert.ok(
          branch.target === "EXIT" || ids.has(branch.target),
          `${node.id} -> ${branch.target} is unknown`,
        );
        assert.equal(typeof branch.when, "string", `${node.id} branch ${JSON.stringify(branch)} missing when`);
      }
    }
  });

  it("every node (except ENTRY) is reachable from at least one predecessor's `next`", () => {
    const incoming = new Set(["ENTRY"]);
    for (const node of nodes) {
      for (const branch of node.next) {
        if (branch.target !== "EXIT") incoming.add(branch.target);
      }
    }
    for (const node of nodes) {
      assert.ok(
        incoming.has(node.id) || node.id === "ENTRY",
        `${node.id} is not reachable from any node's next[]`,
      );
    }
  });

  it("the 2-4 options contract holds for every prompt node (minOptions in [2,4] or null for free-form)", () => {
    for (const node of nodes) {
      if (node.minOptions === null) continue;
      assert.ok(
        node.minOptions >= 2 && node.minOptions <= 4,
        `${node.id} minOptions must be 2-4; got ${node.minOptions}`,
      );
      assert.ok(
        node.maxOptions >= node.minOptions && node.maxOptions <= 4,
        `${node.id} maxOptions must be >= minOptions and <= 4; got ${node.maxOptions}`,
      );
    }
  });

  it("q6 is the only node that can transition to EXIT via `proceed` (terminal write gate)", () => {
    const proceedTargets = [];
    for (const node of nodes) {
      for (const branch of node.next) {
        if (branch.when === "proceed" && branch.target === "done") {
          proceedTargets.push(node.id);
        }
      }
    }
    assert.deepEqual(proceedTargets, ["q6"]);
  });

  it("nodes with customEscape=true list `canHalt: true` (custom option must be able to halt per ambiguity rules)", () => {
    for (const node of nodes) {
      if (!node.customEscape) continue;
      assert.equal(
        node.canHalt,
        true,
        `${node.id} has customEscape=true but canHalt=false; a custom answer outside the configured surface must halt`,
      );
    }
  });
});

describe("scoreArea", () => {
  it("returns zero and empty matches when keywords are absent", () => {
    assert.deepEqual(scoreArea("anything", { name: "x", keywords: [] }), {
      score: 0,
      matchedKeywords: [],
    });
  });

  it("is case-insensitive and normalises against the keyword list length", () => {
    const result = scoreArea("Let's fix the CHECKOUT payment bug", {
      name: "checkout",
      keywords: ["checkout", "cart", "payment", "stripe"],
    });
    assert.deepEqual(result.matchedKeywords.sort(), ["checkout", "payment"]);
    assert.equal(result.score, 2 / 4);
  });

  it("handles non-string inputs without throwing", () => {
    assert.deepEqual(scoreArea(null, { name: "x", keywords: ["x"] }), {
      score: 0,
      matchedKeywords: [],
    });
    assert.deepEqual(scoreArea("hi", null), { score: 0, matchedKeywords: [] });
    assert.deepEqual(scoreArea("hi", { name: "x", keywords: null }), {
      score: 0,
      matchedKeywords: [],
    });
  });
});

describe("rankIssuesForShortlist", () => {
  const ISSUES = [
    { number: 1, title: "low-old", priority: "low", createdAt: "2026-01-01T00:00:00Z" },
    { number: 2, title: "high-new", priority: "high", createdAt: "2026-04-01T00:00:00Z" },
    { number: 3, title: "high-old", priority: "high", createdAt: "2026-02-01T00:00:00Z" },
    { number: 4, title: "medium-new", priority: "medium", createdAt: "2026-04-15T00:00:00Z" },
    { number: 5, title: "none-middle", priority: null, createdAt: "2026-03-01T00:00:00Z" },
  ];

  it("ranks high > medium > low > null; within priority, oldest first", () => {
    const top = rankIssuesForShortlist(ISSUES, 5);
    const order = top.map((i) => i.number);
    // high (old before new) then medium then low then null
    assert.deepEqual(order, [3, 2, 4, 1, 5]);
  });

  it("defaults cap to 4 and never returns more than cap entries", () => {
    assert.equal(rankIssuesForShortlist(ISSUES).length, 4);
    assert.equal(rankIssuesForShortlist(ISSUES, 2).length, 2);
  });

  it("skips malformed entries without throwing", () => {
    const top = rankIssuesForShortlist([{ number: "bad", title: "x" }, { title: "no-num" }, { number: 99, title: "keep" }]);
    assert.deepEqual(top.map((i) => i.number), [99]);
  });

  it("rejects a non-integer cap", () => {
    assert.throws(() => rankIssuesForShortlist(ISSUES, 0), /cap must be a positive integer/);
    assert.throws(() => rankIssuesForShortlist(ISSUES, -1), /cap must be a positive integer/);
    assert.throws(() => rankIssuesForShortlist(ISSUES, 1.5), /cap must be a positive integer/);
  });

  it("returns [] for non-array input instead of throwing", () => {
    assert.deepEqual(rankIssuesForShortlist(null), []);
    assert.deepEqual(rankIssuesForShortlist(undefined), []);
    assert.deepEqual(rankIssuesForShortlist("not an array"), []);
  });
});
