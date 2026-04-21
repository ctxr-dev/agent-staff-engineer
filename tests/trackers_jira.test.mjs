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
        return typeof r.data === "function" ? r.data(opts) : r.data;
      }
    }
    throw new Error(`mockRest: no route for ${method} ${path}`);
  };
  fn.log = log;
  return fn;
}

function route(method, pathHint, data) {
  return { method, pathHint, data };
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

  it("throws on non-string inputs", () => {
    assert.throws(() => normalizeJiraBase(null), /must be a string/);
    assert.throws(() => normalizeJiraBase(undefined), /must be a string/);
    assert.throws(() => normalizeJiraBase(123), /must be a string/);
  });

  it("throws on empty / whitespace-only input (no more https:// garbage)", () => {
    assert.throws(() => normalizeJiraBase(""), /non-empty string/);
    assert.throws(() => normalizeJiraBase("   "), /non-empty string/);
  });
});

// ── issues.createIssue ──────────────────────────────────────────────

describe("jira issues.createIssue", () => {
  it("dedupes by exact title match in the open-set and does NOT hit GET /project (deferred until actual create)", async () => {
    const projectGets = [];
    const api = async (method, path) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        projectGets.push(path);
        return { id: "10000", issueTypes: [] };
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        return {
          issues: [
            { id: "10500", key: "PLAT-77", fields: { summary: "Track log shipping" } },
          ],
        };
      }
      throw new Error(`no route for ${method} ${path}`);
    };
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, { title: "Track log shipping" });
    assert.equal(result.existed, true);
    assert.equal(result.key, "PLAT-77");
    assert.equal(result.url, "https://acme.atlassian.net/browse/PLAT-77");
    // Dedupe-hit path must not waste a GET /project.
    assert.equal(projectGets.length, 0, `expected zero GET /project on dedupe hit; got ${projectGets.length}`);
  });

  it("returns url: null when neither target.site nor JIRA_BASE_URL can be resolved (no https://undefined leak)", async () => {
    const previousEnv = process.env.JIRA_BASE_URL;
    delete process.env.JIRA_BASE_URL;
    try {
      const api = mockRest([
        route("POST", "/rest/api/3/search/jql", {
          issues: [
            { id: "1", key: "PLAT-1", fields: { summary: "Exact" } },
          ],
        }),
      ]);
      const tracker = makeJiraTracker({ project: "PLAT" }, { rest: api });
      const result = await tracker.issues.createIssue({}, { title: "Exact" });
      assert.equal(result.existed, true);
      assert.equal(result.url, null, "url must be null when no base can be resolved, not 'https://undefined/browse/...'");
    } finally {
      if (previousEnv !== undefined) process.env.JIRA_BASE_URL = previousEnv;
    }
  });

  it("falls back to JIRA_BASE_URL for browse url when target.site is absent", async () => {
    const previousEnv = process.env.JIRA_BASE_URL;
    process.env.JIRA_BASE_URL = "jira.internal";
    try {
      const api = mockRest([
        route("POST", "/rest/api/3/search/jql", {
          issues: [
            { id: "1", key: "PLAT-9", fields: { summary: "Another" } },
          ],
        }),
      ]);
      const tracker = makeJiraTracker({ project: "PLAT" }, { rest: api });
      const result = await tracker.issues.createIssue({}, { title: "Another" });
      assert.equal(result.url, "https://jira.internal/browse/PLAT-9");
    } finally {
      if (previousEnv === undefined) {
        delete process.env.JIRA_BASE_URL;
      } else {
        process.env.JIRA_BASE_URL = previousEnv;
      }
    }
  });

  it("paginates dedupe when the exact match lives behind a tokenised first page", async () => {
    // JQL `summary ~ "..."` tokenises, so the first page may be full
    // of near-matches without the exact summary. The dedupe loop must
    // page through up to DEDUPE_SCAN_CAP before declaring "no match"
    // and POSTing a duplicate.
    let searchCalls = 0;
    const api = async (method, path, opts = {}) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        return { id: "10000", issueTypes: [{ id: "200", name: "Task", subtask: false }] };
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        searchCalls++;
        if (opts.body?.nextPageToken == null) {
          // Page 1: 100 near-matches, no exact hit.
          return {
            issues: Array.from({ length: 100 }, (_, i) => ({
              id: String(1000 + i),
              key: `PLAT-${1000 + i}`,
              fields: { summary: `Track log shipping (variant ${i})` },
            })),
            nextPageToken: "p2",
          };
        }
        // Page 2: contains the exact match.
        return {
          issues: [
            { id: "9999", key: "PLAT-9999", fields: { summary: "Track log shipping" } },
          ],
        };
      }
      throw new Error(`no route for ${method} ${path}`);
    };
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, { title: "Track log shipping" });
    assert.equal(result.existed, true);
    assert.equal(result.key, "PLAT-9999");
    assert.equal(searchCalls, 2, "dedupe must have paged through the first 100 near-matches");
  });

  it("falls back to GET /project/:key/issuetypes when the expand response omits issueTypes", async () => {
    // Some Jira instances return /project/:key without the
    // issueTypes field even when expand=issueTypes is requested.
    // Verify the fallback endpoint fills in the default-type picker.
    const fallbackCalls = [];
    const api = async (method, path, opts = {}) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        // Omit issueTypes entirely.
        return { id: "10000" };
      }
      if (method === "GET" && path === "/rest/api/3/project/PLAT/issuetypes") {
        fallbackCalls.push(path);
        return [
          { id: "200", name: "Task", subtask: false },
        ];
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        return { issues: [] };
      }
      if (method === "POST" && path === "/rest/api/3/issue") {
        return { id: "20000", key: "PLAT-100" };
      }
      throw new Error(`no route for ${method} ${path}`);
    };
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, { title: "Needs fallback" });
    assert.equal(result.key, "PLAT-100");
    assert.equal(fallbackCalls.length, 1, "fallback must run when expand response lacks issueTypes");
  });

  it("creates when no dedupe match, using default issue type 'Task'; GET /project is hit exactly once", async () => {
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
    // Exactly one GET /project call: the merged project+issueTypes
    // loader replaces the earlier pattern of hitting /project twice
    // (once for projectId, once for issueTypes).
    const projectGets = api.log.filter((c) => c.method === "GET" && c.path === "/rest/api/3/project/PLAT");
    assert.equal(projectGets.length, 1, `expected exactly one GET /project; got ${projectGets.length}`);
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

  it("translates snake_case vocabulary keys to match spaced Jira names (e.g. 'in_progress' -> 'In Progress')", async () => {
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
    const result = await tracker.issues.updateIssueStatus({}, { issueId: "PLAT-1", status: "in_progress" });
    assert.equal(result.transitionId, "10");
  });

  it("no-ops when current Jira status matches a snake_case vocab key (e.g. 'In Progress' vs 'in_progress')", async () => {
    const api = mockRest([
      route("GET", "/rest/api/3/issue/PLAT-1", {
        id: "1", key: "PLAT-1",
        fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.issues.updateIssueStatus({}, { issueId: "PLAT-1", status: "in_progress" });
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

  it("rejects whitespace in filter labels (parity with createIssue / relabelIssue / reconcileLabels)", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}, { labels: ["has space"] }),
      /cannot contain whitespace/,
    );
  });
});

// ── labels.reconcileLabels ──────────────────────────────────────────

describe("jira labels.reconcileLabels", () => {
  it("produces a plan against the project's in-use label set", async () => {
    const api = mockRest([
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

  it("preserves original label casing on deprecate entries (not lowercased)", async () => {
    const api = mockRest([
      route("POST", "/rest/api/3/search/jql", {
        issues: [
          { id: "1", fields: { labels: ["LegacyUI", "wave-1"] } },
        ],
        nextPageToken: null,
      }),
    ]);
    const tracker = makeJiraTracker(TARGET, { rest: api });
    const result = await tracker.labels.reconcileLabels({}, {
      taxonomy: ["wave-1"],
      allowDeprecate: true,
    });
    const deprecateEntry = result.plan.find((p) => p.action === "deprecate");
    assert.ok(deprecateEntry, "expected a deprecate entry for LegacyUI");
    assert.equal(deprecateEntry.name, "LegacyUI", "deprecate.name must preserve the original casing seen on Jira, not the lowered key");
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

  it("throws when the in-use-labels scan is truncated (MAX_PAGES * MAX_PAGE_SIZE issues with a lingering nextPageToken)", async () => {
    // Simulate a project with > 1000 issues: every page returns 100
    // issues and always offers a nextPageToken. The probe is the page
    // check at MAX_PAGES - 1 that flips `truncated`.
    let page = 0;
    const api = async (method, path) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        return { id: "10000", issueTypes: [] };
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        page++;
        return {
          issues: Array.from({ length: 100 }, (_, i) => ({
            id: String(page * 100 + i),
            fields: { labels: ["seen"] },
          })),
          nextPageToken: "x",
        };
      }
      throw new Error(`no route for ${method} ${path}`);
    };
    const tracker = makeJiraTracker(TARGET, { rest: api });
    await assert.rejects(
      () => tracker.labels.reconcileLabels({}, { taxonomy: ["new-label"] }),
      /in-use-labels scan was truncated/,
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

  it("apply: sweeps every matching issue and swaps label via delta update; no per-issue GET", async () => {
    // The mock tracks per-issue label state so the search query stops
    // returning issues whose `old` label has already been removed. That
    // models real Jira behaviour: the JQL `labels = old` re-evaluates
    // on every page fetch, not against a snapshot, so mutating during
    // iteration shrinks the result set.
    const state = new Map([
      ["PLAT-1", ["old", "wave-1"]],
      ["PLAT-2", ["old"]],
    ]);
    let searchCalls = 0;
    const issueGets = [];
    const api = async (method, path, opts = {}) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        return { id: "10000", issueTypes: [] };
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        searchCalls++;
        const stillCarryingOld = [];
        for (const [key, labels] of state) {
          if (labels.includes("old")) {
            stillCarryingOld.push({ id: key, key, fields: { labels: [...labels] } });
          }
        }
        return { issues: stillCarryingOld };
      }
      if (method === "GET" && path.startsWith("/rest/api/3/issue/")) {
        issueGets.push(path);
        const key = path.split("/").pop();
        return { id: key, key, fields: { labels: [...(state.get(key) ?? [])] } };
      }
      if (method === "PUT" && path.startsWith("/rest/api/3/issue/")) {
        const key = path.split("/").pop();
        const current = state.get(key) ?? [];
        const ops = opts.body?.update?.labels ?? [];
        let next = [...current];
        for (const op of ops) {
          if (op.add && !next.includes(op.add)) next.push(op.add);
          if (op.remove) next = next.filter((l) => l !== op.remove);
        }
        state.set(key, next);
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
    assert.equal(searchCalls, 2);
    // Performance: sweepLabel reuses labels from the search batch, so
    // no per-issue GET /rest/api/3/issue/:key is required.
    assert.equal(issueGets.length, 0, `expected zero per-issue GETs; got ${issueGets.length}`);
    assert.deepEqual([...state.get("PLAT-1")].sort(), ["new", "wave-1"]);
    assert.deepEqual([...state.get("PLAT-2")], ["new"]);
  });

  it("rejects labels with whitespace in the plan", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [{ from: "has space", to: "ok" }],
      apply: true,
    });
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].error, /whitespace/);
  });

  it("treats empty-string `to` as delete but rejects whitespace-only `to`", async () => {
    const tracker = makeJiraTracker(TARGET, { rest: mockRest([]) });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [
        { from: "old", to: "" },
        { from: "old", to: "   " },
      ],
      apply: false,
    });
    assert.equal(result.results[0].action, "would-delete");
    assert.equal(result.results[1].success, false);
    assert.match(result.results[1].error, /empty string \(''\) to delete/);
  });

  it("sweepLabel surfaces a partial-sweep error when more issues remain after MAX_PAGES", async () => {
    // Mock relabelIssue's pre-fetch + PUT so every swept issue returns
    // cleanly, AND always report a non-empty search batch so the
    // sweep exhausts MAX_PAGES. After the cap, the post-sweep probe
    // returns 1 issue, which triggers the partial-rename error.
    let searchCalls = 0;
    const api = async (method, path, opts = {}) => {
      if (method === "GET" && path === "/rest/api/3/project/PLAT") {
        return { id: "10000", issueTypes: [] };
      }
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        searchCalls++;
        // Probe call uses maxResults: 1; always return 1 issue here
        // to force the partial-sweep branch.
        const max = opts.body?.maxResults ?? 100;
        return {
          issues: Array.from({ length: Math.min(100, max) }, (_, i) => ({
            id: String(searchCalls * 100 + i),
            key: `PLAT-${searchCalls * 100 + i}`,
            fields: { labels: ["old"] },
          })),
        };
      }
      if (method === "GET" && path.startsWith("/rest/api/3/issue/")) {
        const key = path.split("/").pop();
        return { id: "x", key, fields: { labels: ["old"] } };
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
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].error, /partial rename/);
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
