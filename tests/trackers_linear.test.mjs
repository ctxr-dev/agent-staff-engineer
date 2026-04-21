import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeLinearTracker } from "../scripts/lib/trackers/linear.mjs";
import { NotSupportedError } from "../scripts/lib/trackers/tracker.mjs";

// ── Fixtures ────────────────────────────────────────────────────────

const TEAM_RESPONSE = {
  teams: { nodes: [{ id: "team-abc", key: "ENG", name: "Engineering" }] },
};

const STATES_RESPONSE = {
  workflowStates: {
    nodes: [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-todo", name: "Todo", type: "unstarted" },
      { id: "state-progress", name: "In Progress", type: "started" },
      { id: "state-review", name: "In Review", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
      { id: "state-cancelled", name: "Cancelled", type: "canceled" },
    ],
  },
};

const LABELS_RESPONSE = {
  issueLabels: {
    nodes: [
      { id: "label-bug", name: "bug", color: "#ff0000" },
      { id: "label-feat", name: "feature", color: "#00ff00" },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

function fixture(queryHint, data) {
  return { queryHint, data };
}

function mockGraphql(responses) {
  const log = [];
  const fn = async (query, variables = {}) => {
    log.push({ query, variables });
    for (const r of responses) {
      if (query.includes(r.queryHint)) return r.data;
    }
    throw new Error(`mockGraphql: no fixture matched query:\n${query}`);
  };
  fn.log = log;
  return fn;
}

const TARGET = { team: "ENG" };

// ── review.* stubs ──────────────────────────────────────────────────

describe("linear review.* stubs", () => {
  const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
  for (const method of ["requestReview", "pollForReview", "fetchUnresolvedThreads", "resolveThread", "ciStateOnHead"]) {
    it(`review.${method} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.review[method]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "linear");
        assert.equal(err.namespace, "review");
        return true;
      });
    });
  }
});

// ── projects.* stubs ────────────────────────────────────────────────

describe("linear projects.* stubs", () => {
  const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
  for (const method of ["listProjectItems", "updateProjectField", "reconcileProjectFields"]) {
    it(`projects.${method} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.projects[method]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "linear");
        return true;
      });
    });
  }
});

// ── issues.createIssue ──────────────────────────────────────────────

describe("linear issues.createIssue", () => {
  it("creates an issue and returns existed:false", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      // Dedupe search returns no match
      fixture("issues(filter:", { issues: { nodes: [] } }),
      fixture("issueCreate(", {
        issueCreate: {
          success: true,
          issue: { id: "i1", identifier: "ENG-1", title: "Test", url: "https://linear.app/ENG-1" },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.createIssue({}, { title: "Test", body: "Desc" });
    assert.equal(result.id, "i1");
    assert.equal(result.existed, false);
  });

  it("dedupes by exact title and returns existed:true", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("issues(filter:", {
        issues: { nodes: [{ id: "i-exist", identifier: "ENG-99", title: "Dupe", url: "u" }] },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.createIssue({}, { title: "Dupe" });
    assert.equal(result.id, "i-exist");
    assert.equal(result.existed, true);
    // No create mutation should have been called
    assert.ok(!gql.log.some((c) => c.query.includes("issueCreate(")));
  });

  it("throws on empty title", async () => {
    const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
    await assert.rejects(
      () => tracker.issues.createIssue({}, { title: "" }),
      /title must be a non-empty string/,
    );
  });

  it("throws when label not found", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("issues(filter:", { issues: { nodes: [] } }),
      fixture("issueLabels(", LABELS_RESPONSE),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await assert.rejects(
      () => tracker.issues.createIssue({}, { title: "X", labels: ["nonexistent"] }),
      /labels not found: nonexistent/,
    );
  });
});

// ── issues.updateIssueStatus ────────────────────────────────────────

describe("linear issues.updateIssueStatus", () => {
  it("maps status name to state ID", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issue(id:", { issue: { state: { id: "state-backlog" } } }),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: { id: "i1", identifier: "ENG-1", state: { name: "In Progress", type: "started" } },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.updateIssueStatus({}, { issueId: "i1", status: "In Progress" });
    assert.equal(result.state.name, "In Progress");
  });

  it("maps agent vocabulary key via type fallback", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issue(id:", { issue: { state: { id: "state-backlog" } } }),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: { id: "i1", identifier: "ENG-1", state: { name: "In Progress", type: "started" } },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await tracker.issues.updateIssueStatus({}, { issueId: "i1", status: "in_progress" });
    const updateCall = gql.log.find((c) => c.query.includes("issueUpdate("));
    assert.equal(updateCall.variables.stateId, "state-progress");
  });

  it("refuses to set done (human gate)", async () => {
    const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
    await assert.rejects(
      () => tracker.issues.updateIssueStatus({}, { issueId: "i1", status: "done" }),
      /refusing to set Done/,
    );
  });

  it("no-ops when already in the requested state", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issue(id:", { issue: { state: { id: "state-progress" } } }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.updateIssueStatus({}, { issueId: "i1", status: "In Progress" });
    assert.equal(result.noop, true);
    assert.ok(!gql.log.some((c) => c.query.includes("issueUpdate(")));
  });

  it("throws on non-string status", async () => {
    const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
    await assert.rejects(
      () => tracker.issues.updateIssueStatus({}, { issueId: "i1", status: 42 }),
      /status must be a non-empty string/,
    );
  });
});

// ── issues.comment ──────────────────────────────────────────────────

describe("linear issues.comment", () => {
  it("creates a comment", async () => {
    const gql = mockGraphql([
      fixture("commentCreate(", {
        commentCreate: { success: true, comment: { id: "c1", body: "Hi", url: "u" } },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.comment({}, { issueId: "i1", body: "Hi" });
    assert.equal(result.id, "c1");
  });
});

// ── issues.relabelIssue (delta semantics) ───────────────────────────

describe("linear issues.relabelIssue", () => {
  it("adds labels via delta", async () => {
    const gql = mockGraphql([
      // Fetch current labels on issue
      fixture("issue(id:", { issue: { labels: { nodes: [{ id: "label-feat", name: "feature" }] } } }),
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: { id: "i1", identifier: "ENG-1", labels: { nodes: [{ id: "label-feat", name: "feature" }, { id: "label-bug", name: "bug" }] } },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.relabelIssue({}, { issueId: "i1", add: ["bug"] });
    assert.equal(result.labels.length, 2);
    // Verify labelIds in mutation includes both existing + new
    const updateCall = gql.log.find((c) => c.query.includes("issueUpdate("));
    assert.ok(updateCall.variables.labelIds.includes("label-feat"));
    assert.ok(updateCall.variables.labelIds.includes("label-bug"));
  });

  it("removes labels via delta", async () => {
    const gql = mockGraphql([
      fixture("issue(id:", { issue: { labels: { nodes: [{ id: "label-feat", name: "feature" }, { id: "label-bug", name: "bug" }] } } }),
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: { id: "i1", identifier: "ENG-1", labels: { nodes: [{ id: "label-feat", name: "feature" }] } },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.relabelIssue({}, { issueId: "i1", remove: ["bug"] });
    const updateCall = gql.log.find((c) => c.query.includes("issueUpdate("));
    assert.ok(!updateCall.variables.labelIds.includes("label-bug"));
    assert.ok(updateCall.variables.labelIds.includes("label-feat"));
  });
});

// ── issues.getIssue ─────────────────────────────────────────────────

describe("linear issues.getIssue", () => {
  it("returns issue details", async () => {
    const gql = mockGraphql([
      fixture("issue(id:", {
        issue: {
          id: "i1", identifier: "ENG-1", title: "Test", description: "D", url: "u",
          state: { id: "s1", name: "Backlog", type: "backlog" },
          labels: { nodes: [] }, assignee: null,
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.getIssue({}, { issueId: "i1" });
    assert.equal(result.identifier, "ENG-1");
  });

  it("throws when not found", async () => {
    const gql = mockGraphql([fixture("issue(id:", { issue: null })]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await assert.rejects(
      () => tracker.issues.getIssue({}, { issueId: "x" }),
      /not found/,
    );
  });
});

// ── issues.listIssues ───────────────────────────────────────────────

describe("linear issues.listIssues", () => {
  it("lists issues for the team", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("issues(", {
        issues: {
          nodes: [
            { id: "i1", identifier: "ENG-1", title: "A", url: "u", state: { name: "Backlog", type: "backlog" }, labels: { nodes: [] } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.listIssues({});
    assert.equal(result.length, 1);
  });
});

// ── labels.reconcileLabels ──────────────────────────────────────────

describe("linear labels.reconcileLabels", () => {
  it("creates missing labels (apply mode)", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueLabelCreate(", {
        issueLabelCreate: { success: true, issueLabel: { id: "l-new", name: "new-label", color: "#888888" } },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.reconcileLabels({}, {
      taxonomy: ["bug", "new-label"],
      apply: true,
    });
    assert.deepEqual(result.unchanged, ["bug"]);
    assert.deepEqual(result.created, ["new-label"]);
  });

  it("dry-run mode skips mutations", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.reconcileLabels({}, {
      taxonomy: ["new-label"],
      apply: false,
    });
    assert.deepEqual(result.created, ["new-label"]);
    // No create mutation should have been called
    assert.ok(!gql.log.some((c) => c.query.includes("issueLabelCreate(")));
  });

  it("accepts legacy desired payload shape", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.reconcileLabels({}, {
      desired: ["bug"],
    });
    assert.deepEqual(result.unchanged, ["bug"]);
  });
});

// ── labels.relabelBulk ──────────────────────────────────────────────

describe("linear labels.relabelBulk", () => {
  it("applies labels to a single issue", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-1" } },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.relabelBulk({}, {
      issueIds: ["i1"],
      labels: ["bug"],
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].success);
  });

  it("captures per-issue errors without aborting batch", async () => {
    const calls = [];
    const gql = async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes("issueLabels(")) return LABELS_RESPONSE;
      if (query.includes("issueUpdate(")) {
        if (variables.id === "bad") throw new Error("API error on bad");
        return { issueUpdate: { success: true, issue: { id: variables.id, identifier: "X" } } };
      }
      throw new Error("unexpected");
    };
    gql.log = calls;
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.relabelBulk({}, {
      issueIds: ["ok", "bad", "ok2"],
      labels: ["bug"],
    });
    assert.equal(result.length, 3);
    assert.ok(result[0].success);
    assert.equal(result[1].success, false);
    assert.match(result[1].error.message, /API error on bad/);
    assert.ok(result[2].success);
  });
});

// ── Team resolution ─────────────────────────────────────────────────

describe("linear team resolution", () => {
  it("throws when target.team is missing", async () => {
    const tracker = makeLinearTracker({}, { graphql: mockGraphql([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}),
      /requires target\.team/,
    );
  });

  it("caches team ID across calls", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issues(", { issues: { nodes: [], pageInfo: { hasNextPage: false } } }),
      fixture("issue(id:", { issue: { state: { id: "state-backlog" } } }),
      fixture("issueUpdate(", {
        issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-1", state: { name: "In Progress", type: "started" } } },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await tracker.issues.listIssues({});
    await tracker.issues.updateIssueStatus({}, { issueId: "i1", status: "in_progress" });
    const teamCalls = gql.log.filter((c) => c.query.includes("teams("));
    assert.equal(teamCalls.length, 1);
  });
});
