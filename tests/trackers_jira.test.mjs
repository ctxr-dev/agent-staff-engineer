import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeJiraTracker,
  normalizeJiraBase,
} from "../scripts/lib/trackers/jira.mjs";
import { NotSupportedError } from "../scripts/lib/trackers/tracker.mjs";

// ── Mock REST helper ────────────────────────────────────────────────

function mockRest(routes) {
  const log = [];
  const fn = async (method, path, opts = {}) => {
    log.push({ method, path, query: opts.query, body: opts.body });
    for (const r of routes) {
      const pathMatches = typeof r.pathHint === "string"
        ? path.includes(r.pathHint)
        : r.pathHint.test(path);
      if (r.method === method && pathMatches) {
        if (r.once) r.consumed = true;
        return typeof r.data === "function" ? r.data(opts) : r.data;
      }
    }
    throw new Error(`mockRest: no route for ${method} ${path}`);
  };
  fn.log = log;
  return fn;
}

function route(method, pathHint, data, opts = {}) {
  return { method, pathHint, data, ...opts };
}

const TARGET = {
  kind: "jira",
  site: "acme.atlassian.net",
  project: "PLAT",
};

// ── Stubs: review + projects ────────────────────────────────────────

describe("jira review.* stubs", () => {
  const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
  for (const op of ["requestReview", "pollForReview", "fetchUnresolvedThreads", "resolveThread", "ciStateOnHead"]) {
    it(`review.${op} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.review[op]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "jira");
        assert.equal(err.namespace, "review");
        return true;
      });
    });
  }
});

describe("jira projects.* stubs", () => {
  const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
  for (const op of ["listProjectItems", "updateProjectField", "reconcileProjectFields"]) {
    it(`projects.${op} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.projects[op]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "jira");
        assert.equal(err.namespace, "projects");
        return true;
      });
    });
  }
});

// ── normalizeJiraBase ───────────────────────────────────────────────

describe("normalizeJiraBase", () => {
  it("prefixes https:// on bare hostnames (ops.config `site` shape)", () => {
    assert.equal(normalizeJiraBase("acme.atlassian.net"), "https://acme.atlassian.net");
  });

  it("leaves explicit schemes untouched", () => {
    assert.equal(normalizeJiraBase("https://acme.atlassian.net"), "https://acme.atlassian.net");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeJiraBase("  acme.atlassian.net  "), "https://acme.atlassian.net");
  });
});

// ── issues.createIssue ──────────────────────────────────────────────

describe("jira issues.createIssue", () => {
  it("dedupes by exact title match in the open-set", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/project/PLAT", { id: "10000", issueTypes: [] }),
      route("POST", "/rest/api/3/search/jql", {
        issues: [
          { id: "10500", key: "PLAT-77", fields: { summary: "Track log shipping" } },
        ],
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, { title: "Track log shipping" });
    assert.equal(result.existed, true);
    assert.equal(result.key, "PLAT-77");
    assert.equal(result.url, "https://acme.atlassian.net/browse/PLAT-77");
  });

  it("creates when no dedupe match, using default issue type 'Task'", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/project/PLAT", {
        id: "10000",
        issueTypes: [
          { id: "100", name: "Bug", subtask: false },
          { id: "200", name: "Task", subtask: false },
          { id: "900", name: "Sub-task", subtask: true },
        ],
      }),
      route("POST", "/rest/api/3/search/jql", { issues: [] }),
      route("POST", "/rest/api/3/issue", (opts) => ({
        id: "20000",
        key: "PLAT-99",
        __request: opts.body,
      })),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, {
      title: "New work",
      body: "Some *markdown* body",
      labels: ["triage", "wave-1"],
    });
    assert.equal(result.existed, false);
    assert.equal(result.key, "PLAT-99");
    const createCall = api.log.find((c) => c.method === "POST" && c.path === "/rest/api/3/issue");
    assert.equal(createCall.body.fields.issuetype.id, "200");
    assert.equal(createCall.body.fields.summary, "New work");
    assert.deepEqual(createCall.body.fields.labels, ["triage", "wave-1"]);
    assert.equal(createCall.body.fields.description.type, "doc");
  });

  it("rejects templateName (callers must render the body first)", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.createIssue({}, { title: "T", templateName: "bug" }),
      /templateName is not supported/,
    );
  });

  it("rejects labels with whitespace (Jira silently collapses)", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.createIssue({}, { title: "T", labels: ["has space"] }),
      /cannot contain whitespace/,
    );
  });

  it("throws on empty title", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.createIssue({}, { title: "" }),
      /title must be a non-empty string/,
    );
  });
});

// ── issues.updateIssueStatus ────────────────────────────────────────

describe("jira issues.updateIssueStatus", () => {
  it("refuses the vocabulary 'done' key (human gate)", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.updateIssueStatus({}, { issueId: "PLAT-1", status: "done" }),
      /human gate/,
    );
  });

  it("refuses transitioning into a destination in the Done category even when named differently", async () => {
    // Order matters: mockRest uses `includes` for the path hint, so the
    // longer (more specific) path must be declared before the shorter
    // prefix, or a GET /issue/PLAT-1/transitions call would match the
    // plain /issue/PLAT-1 route first.
    const api = mockRest([
      route("GET", "/rest/api/3/issue/PLAT-1/transitions", {
        transitions: [
          {
            id: "50",
            name: "Finish",
            to: { name: "Shipped", statusCategory: { key: "done" } },
          },
        ],
      }),
      route("GET", "/rest/api/3/issue/PLAT-1", {
        id: "1", key: "PLAT-1",
        fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    await assert.rejects(
      () => tracker.issues.updateIssueStatus({}, { issueId: "PLAT-1", status: "Shipped" }),
      /human gate/,
    );
  });

  it("no-ops when already in the requested state", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/issue/PLAT-1", {
        id: "1", key: "PLAT-1",
        fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.updateIssueStatus({}, { issueId: "PLAT-1", status: "in progress" });
    assert.equal(result.noop, true);
  });

  it("discovers transitions and POSTs transition id", async () => {
    const api = mockRest([
      route("POST", "/rest/api/3/issue/PLAT-1/transitions", null),
      route("GET", "/rest/api/3/issue/PLAT-1/transitions", {
        transitions: [
          { id: "10", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
          { id: "20", name: "Review", to: { name: "In Review", statusCategory: { key: "indeterminate" } } },
        ],
      }),
      route("GET", "/rest/api/3/issue/PLAT-1", {
        id: "1", key: "PLAT-1",
        fields: { status: { name: "Backlog", statusCategory: { key: "new" } } },
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.updateIssueStatus({}, { issueId: "PLAT-1", status: "In Progress" });
    assert.equal(result.transitionId, "10");
    const post = api.log.find((c) => c.method === "POST" && c.path.endsWith("/transitions"));
    assert.equal(post.body.transition.id, "10");
  });
});

// ── issues.comment ──────────────────────────────────────────────────

describe("jira issues.comment", () => {
  it("POSTs an ADF-wrapped body", async () => {
    const api = mockRest([
      route("POST", "/rest/api/3/issue/PLAT-1/comment", { id: "501", created: "2026-04-21T20:00Z" }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.comment({}, { issueId: "PLAT-1", body: "Hello **world**" });
    assert.equal(result.id, "501");
    const post = api.log[0];
    assert.equal(post.body.body.type, "doc");
    assert.equal(post.body.body.content[0].type, "paragraph");
  });

  it("throws on empty body", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.comment({}, { issueId: "PLAT-1", body: "" }),
      /body must be a non-empty string/,
    );
  });
});

// ── issues.relabelIssue ─────────────────────────────────────────────

describe("jira issues.relabelIssue", () => {
  it("uses update.labels[] with add/remove deltas", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/issue/PLAT-1", {
        id: "1", key: "PLAT-1", fields: { labels: ["bug"] },
      }),
      route("PUT", "/rest/api/3/issue/PLAT-1", null),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    await tracker.issues.relabelIssue({}, { issueId: "PLAT-1", add: ["feat"], remove: ["bug"] });
    const put = api.log.find((c) => c.method === "PUT");
    assert.deepEqual(put.body.update.labels, [{ add: "feat" }, { remove: "bug" }]);
  });

  it("no-ops when add+remove is empty (without calling PUT)", async () => {
    const api = mockRest([]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.relabelIssue({}, { issueId: "PLAT-1", add: [], remove: [] });
    assert.equal(result.noop, true);
    assert.equal(api.log.length, 0);
  });

  it("no-ops when delta produces no change", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/issue/PLAT-1", {
        id: "1", key: "PLAT-1", fields: { labels: ["feat"] },
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    // add a label that's already present -> no actual change
    const result = await tracker.issues.relabelIssue({}, { issueId: "PLAT-1", add: ["feat"] });
    assert.equal(result.noop, true);
    assert.ok(!api.log.find((c) => c.method === "PUT"));
  });

  it("rejects overlapping add/remove", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.relabelIssue({}, { issueId: "PLAT-1", add: ["x"], remove: ["x"] }),
      /both add and remove/,
    );
  });

  it("rejects labels with whitespace", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.relabelIssue({}, { issueId: "PLAT-1", add: ["has space"] }),
      /cannot contain whitespace/,
    );
  });
});

// ── issues.listIssues ───────────────────────────────────────────────

describe("jira issues.listIssues", () => {
  it("builds JQL for state + labels and returns issues", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/project/PLAT", { id: "10000", issueTypes: [] }),
      route("POST", "/rest/api/3/search/jql", (opts) => ({
        issues: [{ id: "1", key: "PLAT-1", fields: { summary: "one" } }],
        nextPageToken: null,
        __jql: opts.body?.jql,
      })),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const out = await tracker.issues.listIssues({}, { labels: ["wave-1"], limit: 20 });
    assert.equal(out.length, 1);
    const searchCall = api.log.find((c) => c.method === "POST" && c.path === "/rest/api/3/search/jql");
    assert.match(searchCall.body.jql, /project = "PLAT"/);
    assert.match(searchCall.body.jql, /labels in \("wave-1"\)/);
    assert.match(searchCall.body.jql, /statusCategory != Done/);
  });

  it("validates first/limit as positive integers", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}, { limit: 0 }),
      /limit must be a positive integer/,
    );
    await assert.rejects(
      () => tracker.issues.listIssues({}, { first: "50" }),
      /first must be a positive integer/,
    );
  });
});

// ── labels.reconcileLabels ──────────────────────────────────────────

describe("jira labels.reconcileLabels", () => {
  it("produces a plan against the project's in-use label set", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/project/PLAT", { id: "10000", issueTypes: [] }),
      route("POST", "/rest/api/3/search/jql", {
        issues: [
          { id: "1", fields: { labels: ["bug", "wave-1"] } },
          { id: "2", fields: { labels: ["bug"] } },
        ],
        nextPageToken: null,
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.labels.reconcileLabels({}, {
      taxonomy: ["bug", "wave-2"],
    });
    assert.equal(result.mode, "dry-run");
    const planByName = Object.fromEntries(result.plan.map((p) => [p.name, p.action]));
    assert.equal(planByName["bug"], "unchanged");
    assert.equal(planByName["wave-2"], "create");
  });

  it("rejects non-boolean apply (parity with other backends)", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.labels.reconcileLabels({}, { taxonomy: ["x"], apply: "true" }),
      /apply must be a boolean/,
    );
  });

  it("rejects labels with whitespace in the taxonomy", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.labels.reconcileLabels({}, { taxonomy: ["has space"] }),
      /cannot contain whitespace/,
    );
  });
});

// ── labels.relabelBulk ──────────────────────────────────────────────

describe("jira labels.relabelBulk", () => {
  it("dry-run reports would-rename without mutations", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/project/PLAT", { id: "10000", issueTypes: [] }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [{ from: "old", to: "new" }],
      apply: false,
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.results[0].action, "would-rename");
    assert.ok(!api.log.find((c) => c.method === "PUT"));
  });

  it("apply: sweeps every matching issue and swaps label via delta update", async () => {
    const issuesWithOld = [
      { id: "1", key: "PLAT-1", fields: { labels: ["old", "wave-1"] } },
      { id: "2", key: "PLAT-2", fields: { labels: ["old"] } },
    ];
    let searchCalls = 0;
    const api = async (method, path, opts = {}) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        return { id: "10000", issueTypes: [] };
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        searchCalls++;
        // First call: the label-sweep query. Second call: issue-by-issue
        // relabelIssue does not search, so only one sweep is expected.
        return { issues: issuesWithOld, nextPageToken: null };
      }
      if (method === "GET" && path.startsWith("/rest/api/3/issue/")) {
        const key = path.split("/").pop();
        const issue = issuesWithOld.find((i) => i.key === key);
        return issue;
      }
      if (method === "PUT" && path.startsWith("/rest/api/3/issue/")) {
        return null;
      }
      throw new Error(`no route for ${method} ${path}`);
    };
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [{ from: "old", to: "new" }],
      apply: true,
    });
    assert.equal(result.mode, "applied");
    assert.equal(result.results[0].action, "renamed");
    assert.equal(result.results[0].issuesTouched, 2);
    assert.equal(searchCalls, 1);
  });

  it("rejects labels with whitespace in the plan", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/project/PLAT", { id: "10000", issueTypes: [] }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [{ from: "has space", to: "ok" }],
      apply: true,
    });
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].error, /whitespace/);
  });
});

// ── target resolution ──────────────────────────────────────────────

describe("jira target resolution", () => {
  it("requires target.project", async () => {
    const tracker = makeJiraTracker({ site: "acme.atlassian.net" }, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}, {}),
      /requires target\.project/,
    );
  });
});
