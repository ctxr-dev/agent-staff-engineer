import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeLinearTracker } from "../scripts/lib/trackers/linear.mjs";
import { NotSupportedError } from "../scripts/lib/trackers/tracker.mjs";

// ── Fixtures ────────────────────────────────────────────────────────

const TEAM_RESPONSE = {
  teams: {
    nodes: [{ id: "team-abc", key: "ENG", name: "Engineering" }],
  },
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

/**
 * Build a mock graphql function that dispatches on query content.
 * Each entry in `responses` is { queryHint: string, data: object }.
 * The mock matches the first entry whose queryHint appears in the query.
 * Calls are recorded in the returned `log` array.
 */
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

  for (const method of [
    "requestReview",
    "pollForReview",
    "fetchUnresolvedThreads",
    "resolveThread",
    "ciStateOnHead",
  ]) {
    it(`review.${method} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.review[method]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "linear");
        assert.equal(err.namespace, "review");
        assert.match(err.message, /no native PR review/);
        return true;
      });
    });
  }
});

// ── projects.* stubs ────────────────────────────────────────────────

describe("linear projects.* stubs", () => {
  const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });

  for (const method of [
    "listProjectItems",
    "updateProjectField",
    "reconcileProjectFields",
  ]) {
    it(`projects.${method} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.projects[method]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "linear");
        assert.equal(err.namespace, "projects");
        return true;
      });
    });
  }
});

// ── issues.createIssue ──────────────────────────────────────────────

describe("linear issues.createIssue", () => {
  it("creates an issue with title and body", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("issueCreate(", {
        issueCreate: {
          success: true,
          issue: {
            id: "issue-1",
            identifier: "ENG-1",
            title: "Test issue",
            url: "https://linear.app/team/ENG-1",
          },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.createIssue({}, {
      title: "Test issue",
      body: "Description here",
    });
    assert.equal(result.id, "issue-1");
    assert.equal(result.identifier, "ENG-1");
    assert.equal(result.existed, false);
    // Verify team lookup happened
    assert.ok(gql.log.some((c) => c.query.includes("teams(")));
  });

  it("creates an issue with labels", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueCreate(", {
        issueCreate: {
          success: true,
          issue: {
            id: "issue-2",
            identifier: "ENG-2",
            title: "With labels",
            url: "https://linear.app/team/ENG-2",
          },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.createIssue({}, {
      title: "With labels",
      labels: ["bug"],
    });
    assert.equal(result.id, "issue-2");
    // Verify label lookup + labelIds in mutation
    const createCall = gql.log.find((c) => c.query.includes("issueCreate("));
    assert.ok(createCall);
    assert.deepEqual(createCall.variables.input.labelIds, ["label-bug"]);
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
  it("maps status name to state ID via name match", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-1",
            identifier: "ENG-1",
            state: { name: "In Progress", type: "started" },
          },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.updateIssueStatus({}, {
      issueId: "issue-1",
      status: "In Progress",
    });
    assert.equal(result.state.name, "In Progress");
  });

  it("maps agent vocabulary key via type fallback", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-1",
            identifier: "ENG-1",
            state: { name: "In Progress", type: "started" },
          },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.updateIssueStatus({}, {
      issueId: "issue-1",
      status: "in_progress",
    });
    // in_progress maps to type "started" which resolves to "In Progress"
    const updateCall = gql.log.find((c) => c.query.includes("issueUpdate("));
    assert.equal(updateCall.variables.stateId, "state-progress");
  });

  it("throws on unknown status", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await assert.rejects(
      () => tracker.issues.updateIssueStatus({}, { issueId: "x", status: "nonexistent" }),
      /no workflow state matching 'nonexistent'/,
    );
  });
});

// ── issues.comment ──────────────────────────────────────────────────

describe("linear issues.comment", () => {
  it("creates a comment", async () => {
    const gql = mockGraphql([
      fixture("commentCreate(", {
        commentCreate: {
          success: true,
          comment: { id: "comment-1", body: "Hello", url: "https://linear.app/c/1" },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.comment({}, {
      issueId: "issue-1",
      body: "Hello",
    });
    assert.equal(result.id, "comment-1");
  });

  it("throws on empty body", async () => {
    const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
    await assert.rejects(
      () => tracker.issues.comment({}, { issueId: "x", body: "" }),
      /body must be a non-empty string/,
    );
  });
});

// ── issues.relabelIssue ─────────────────────────────────────────────

describe("linear issues.relabelIssue", () => {
  it("sets labels on an issue", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-1",
            identifier: "ENG-1",
            labels: { nodes: [{ id: "label-bug", name: "bug" }] },
          },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.relabelIssue({}, {
      issueId: "issue-1",
      labels: ["bug"],
    });
    assert.equal(result.labels.length, 1);
    assert.equal(result.labels[0].name, "bug");
  });
});

// ── issues.getIssue ─────────────────────────────────────────────────

describe("linear issues.getIssue", () => {
  it("returns issue details", async () => {
    const gql = mockGraphql([
      fixture("issue(id:", {
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Test",
          description: "Desc",
          url: "https://linear.app/ENG-1",
          state: { id: "s1", name: "Backlog", type: "backlog" },
          labels: { nodes: [] },
          assignee: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.getIssue({}, { issueId: "issue-1" });
    assert.equal(result.identifier, "ENG-1");
    assert.equal(result.state.name, "Backlog");
  });

  it("throws when issue not found", async () => {
    const gql = mockGraphql([fixture("issue(id:", { issue: null })]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await assert.rejects(
      () => tracker.issues.getIssue({}, { issueId: "missing" }),
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
            { id: "i1", identifier: "ENG-1", title: "A", url: "u1", state: { name: "Backlog", type: "backlog" }, labels: { nodes: [] } },
            { id: "i2", identifier: "ENG-2", title: "B", url: "u2", state: { name: "Done", type: "completed" }, labels: { nodes: [] } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.listIssues({});
    assert.equal(result.length, 2);
    assert.equal(result[0].identifier, "ENG-1");
  });

  it("applies state filter", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issues(", {
        issues: {
          nodes: [{ id: "i1", identifier: "ENG-1", title: "A", url: "u1", state: { name: "Backlog", type: "backlog" }, labels: { nodes: [] } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.issues.listIssues({}, { state: "backlog" });
    assert.equal(result.length, 1);
    // Verify filter has state constraint
    const listCall = gql.log.find((c) => c.query.includes("issues("));
    assert.ok(listCall.variables.filter.state);
  });
});

// ── labels.reconcileLabels ──────────────────────────────────────────

describe("linear labels.reconcileLabels", () => {
  it("creates missing labels and skips existing", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueLabelCreate(", {
        issueLabelCreate: {
          success: true,
          issueLabel: { id: "label-new", name: "new-label", color: "#888888" },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.reconcileLabels({}, {
      desired: ["bug", "new-label"],
    });
    assert.deepEqual(result.unchanged, ["bug"]);
    assert.deepEqual(result.created, ["new-label"]);
    assert.deepEqual(result.updated, []);
  });

  it("updates label color when different", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueLabelUpdate(", {
        issueLabelUpdate: {
          success: true,
          issueLabel: { id: "label-bug", name: "bug", color: "#0000ff" },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.reconcileLabels({}, {
      desired: [{ name: "bug", color: "#0000ff" }],
    });
    assert.deepEqual(result.updated, ["bug"]);
  });
});

// ── labels.relabelBulk ──────────────────────────────────────────────

describe("linear labels.relabelBulk", () => {
  it("applies labels to multiple issues", async () => {
    const gql = mockGraphql([
      fixture("issueLabels(", LABELS_RESPONSE),
      fixture("issueUpdate(", {
        issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-1" } },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    const result = await tracker.labels.relabelBulk({}, {
      issueIds: ["i1", "i2"],
      labels: ["bug"],
    });
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.success));
  });

  it("throws on empty issueIds", async () => {
    const tracker = makeLinearTracker(TARGET, { graphql: mockGraphql([]) });
    await assert.rejects(
      () => tracker.labels.relabelBulk({}, { issueIds: [], labels: ["bug"] }),
      /issueIds must be a non-empty array/,
    );
  });
});

// ── Team resolution errors ──────────────────────────────────────────

describe("linear team resolution", () => {
  it("throws when target.team is missing", async () => {
    const gql = mockGraphql([]);
    const tracker = makeLinearTracker({}, { graphql: gql });
    await assert.rejects(
      () => tracker.issues.listIssues({}),
      /requires target\.team/,
    );
  });

  it("throws when team key not found", async () => {
    const gql = mockGraphql([
      fixture("teams(", { teams: { nodes: [] } }),
    ]);
    const tracker = makeLinearTracker({ team: "NOPE" }, { graphql: gql });
    await assert.rejects(
      () => tracker.issues.listIssues({}),
      /team with key 'NOPE' not found/,
    );
  });

  it("caches team ID across calls", async () => {
    const gql = mockGraphql([
      fixture("teams(", TEAM_RESPONSE),
      fixture("workflowStates(", STATES_RESPONSE),
      fixture("issues(", {
        issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
      fixture("issueUpdate(", {
        issueUpdate: {
          success: true,
          issue: { id: "i1", identifier: "ENG-1", state: { name: "Done", type: "completed" } },
        },
      }),
    ]);
    const tracker = makeLinearTracker(TARGET, { graphql: gql });
    await tracker.issues.listIssues({});
    await tracker.issues.updateIssueStatus({}, { issueId: "i1", status: "done" });
    // team lookup should happen only once
    const teamCalls = gql.log.filter((c) => c.query.includes("teams("));
    assert.equal(teamCalls.length, 1);
  });
});
