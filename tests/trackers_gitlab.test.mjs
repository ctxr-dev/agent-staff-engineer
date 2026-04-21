import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeGitlabTracker, normalizeGitlabBase } from "../scripts/lib/trackers/gitlab.mjs";
import { NotSupportedError } from "../scripts/lib/trackers/tracker.mjs";

// ── Mock REST helper ────────────────────────────────────────────────

function mockRest(routes) {
  const log = [];
  const fn = async (method, path, opts = {}) => {
    log.push({ method, path, query: opts.query, body: opts.body });
    for (const r of routes) {
      if (r.method === method && path.includes(r.pathHint)) {
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

const TARGET = { namespace: "acme", repo: "myapp" };

// ── projects.* stubs ────────────────────────────────────────────────

describe("gitlab projects.* stubs", () => {
  const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
  for (const op of ["listProjectItems", "updateProjectField", "reconcileProjectFields"]) {
    it(`projects.${op} throws NotSupportedError`, async () => {
      await assert.rejects(() => tracker.projects[op]({}), (err) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.kind, "gitlab");
        return true;
      });
    });
  }
});

// ── review.requestReview stub ───────────────────────────────────────

describe("gitlab review.requestReview stub", () => {
  it("throws NotSupportedError with pointed message", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(() => tracker.review.requestReview({}), (err) => {
      assert.ok(err instanceof NotSupportedError);
      assert.equal(err.kind, "gitlab");
      assert.match(err.message, /approval rules/);
      return true;
    });
  });
});

// ── review.pollForReview ────────────────────────────────────────────

describe("gitlab review.pollForReview", () => {
  it("returns ciState + unresolvedCount + reviewOnHead=true when ctx.botLogins matches the HEAD note author", async () => {
    const calls = [];
    const api = async (method, path) => {
      calls.push({ method, path });
      if (path.includes("/discussions")) {
        return [
          {
            id: "d1",
            notes: [
              { resolvable: true, resolved: false, body: "Fix this", position: { head_sha: "abc123", new_line: 10, new_path: "file.js" }, author: { username: "Gitlab-Bot" } },
            ],
          },
          {
            id: "d2",
            notes: [{ resolvable: true, resolved: true, body: "OK", position: {}, author: { username: "gitlab-bot" } }],
          },
        ];
      }
      return {
        iid: 1, sha: "abc123",
        diff_refs: { head_sha: "abc123" },
        head_pipeline: { status: "success" },
      };
    };
    api.log = calls;
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.review.pollForReview({ mrIid: 1, botLogins: ["gitlab-bot"] });
    assert.equal(result.ciState, "SUCCESS");
    assert.equal(result.unresolvedCount, 1);
    assert.equal(result.reviewOnHead, true);
  });

  it("reviewOnHead=false when only a non-bot user has reviewed HEAD", async () => {
    const api = async (method, path) => {
      if (path.includes("/discussions")) {
        return [
          {
            id: "d1",
            notes: [
              { resolvable: true, resolved: false, body: "human review on HEAD", position: { head_sha: "abc123", new_line: 10 }, author: { username: "alice" } },
            ],
          },
        ];
      }
      return { diff_refs: { head_sha: "abc123" }, head_pipeline: { status: "success" } };
    };
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.review.pollForReview({ mrIid: 1, botLogins: ["gitlab-bot"] });
    assert.equal(result.reviewOnHead, false);
    assert.equal(result.unresolvedCount, 1);
  });

  it("reviewOnHead=false when botLogins matches but the note targets a stale SHA", async () => {
    const api = async (method, path) => {
      if (path.includes("/discussions")) {
        return [
          {
            id: "d1",
            notes: [
              { resolvable: true, resolved: false, body: "stale", position: { head_sha: "old999", new_line: 2 }, author: { username: "gitlab-bot" } },
            ],
          },
        ];
      }
      return { diff_refs: { head_sha: "abc123" }, head_pipeline: { status: "success" } };
    };
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.review.pollForReview({ mrIid: 1, botLogins: ["gitlab-bot"] });
    assert.equal(result.reviewOnHead, false);
  });

  it("falls back to author.bot=true when ctx.botLogins is absent", async () => {
    const api = async (method, path) => {
      if (path.includes("/discussions")) {
        return [
          {
            id: "d1",
            notes: [
              { resolvable: true, resolved: false, body: "bot review on HEAD", position: { head_sha: "abc123", new_line: 1 }, author: { username: "someBot", bot: true } },
            ],
          },
        ];
      }
      return { diff_refs: { head_sha: "abc123" }, head_pipeline: { status: "success" } };
    };
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.review.pollForReview({ mrIid: 1 });
    assert.equal(result.reviewOnHead, true);
  });

  it("maps pipeline failed to FAILURE", async () => {
    const calls = [];
    const api = async (method, path) => {
      calls.push({ method, path });
      if (path.includes("/discussions")) return [];
      return { head_pipeline: { status: "failed" }, diff_refs: {} };
    };
    api.log = calls;
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.review.pollForReview({ mrIid: 2 });
    assert.equal(result.ciState, "FAILURE");
    assert.equal(result.unresolvedCount, 0);
  });
});

// ── review.fetchUnresolvedThreads ───────────────────────────────────

describe("gitlab review.fetchUnresolvedThreads", () => {
  it("returns unresolved discussion threads with correct shape", async () => {
    const api = mockRest([
      route("GET", "/discussions", [
        {
          id: "d1",
          notes: [
            { resolvable: true, resolved: false, body: "Fix", position: { new_path: "src/a.js", new_line: 5, head_sha: "sha1" }, author: { username: "reviewer" } },
          ],
        },
        {
          id: "d2",
          notes: [{ resolvable: true, resolved: true, body: "OK", position: {}, author: { username: "x" } }],
        },
        {
          id: "d3",
          notes: [{ resolvable: false, body: "General comment", author: { username: "y" } }],
        },
      ]),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const threads = await tracker.review.fetchUnresolvedThreads({ mrIid: 1 });
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, "d1");
    assert.equal(threads[0].path, "src/a.js");
    assert.equal(threads[0].line, 5);
    assert.equal(threads[0].authorLogin, "reviewer");
  });

  it("mixed discussion: picks the still-unresolved note, not an earlier resolved one", async () => {
    // Ordering matters here: the earlier note is resolvable AND already
    // resolved; the later note is the live one. Previous code picked
    // the first `resolvable` match (the resolved one), so the thread
    // surfaced with stale path / author / body.
    const api = mockRest([
      route("GET", "/discussions", [
        {
          id: "d-mixed",
          notes: [
            { resolvable: true, resolved: true, body: "old closed comment", position: { new_path: "old/file.js", new_line: 2, head_sha: "sha-old" }, author: { username: "resolved-author" } },
            { resolvable: true, resolved: false, body: "still open", position: { new_path: "src/real.js", new_line: 99, head_sha: "sha-new" }, author: { username: "live-author" } },
          ],
        },
      ]),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const threads = await tracker.review.fetchUnresolvedThreads({ mrIid: 1 });
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, "d-mixed");
    assert.equal(threads[0].path, "src/real.js", "must surface the live note's path, not the resolved predecessor's");
    assert.equal(threads[0].line, 99);
    assert.equal(threads[0].authorLogin, "live-author");
    assert.equal(threads[0].body, "still open");
    assert.equal(threads[0].commitSha, "sha-new");
  });
});

// ── review.resolveThread ────────────────────────────────────────────

describe("gitlab review.resolveThread", () => {
  it("PUTs resolved:true on the discussion", async () => {
    const api = mockRest([
      route("PUT", "/discussions/d1", { id: "d1", resolved: true }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await tracker.review.resolveThread({ mrIid: 1 }, "d1");
    assert.equal(api.log[0].body.resolved, true);
  });
});

// ── review.ciStateOnHead ────────────────────────────────────────────

describe("gitlab review.ciStateOnHead", () => {
  it("returns mapped CI state", async () => {
    const api = mockRest([
      route("GET", "/merge_requests/1", { head_pipeline: { status: "running" } }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.review.ciStateOnHead({ mrIid: 1 });
    assert.equal(result, "PENDING");
  });
});

// ── issues.createIssue ──────────────────────────────────────────────

describe("gitlab issues.createIssue", () => {
  it("dedupes by exact title", async () => {
    const api = mockRest([
      route("GET", "/issues", [{ id: 1, iid: 1, title: "Existing", web_url: "u" }]),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, { title: "Existing" });
    assert.equal(result.existed, true);
    assert.equal(result.iid, 1);
  });

  it("creates when no dedupe match", async () => {
    const api = mockRest([
      route("GET", "/issues", []),
      route("POST", "/issues", { id: 2, iid: 2, web_url: "u2" }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.issues.createIssue({}, { title: "New issue", body: "Desc" });
    assert.equal(result.existed, false);
    assert.equal(result.iid, 2);
  });

  it("throws on empty title", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.createIssue({}, { title: "" }),
      /title must be a non-empty string/,
    );
  });
});

// ── issues.updateIssueStatus ────────────────────────────────────────

describe("gitlab issues.updateIssueStatus", () => {
  it("refuses done/closed (human gate)", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.updateIssueStatus({}, { issueId: 1, status: "done" }),
      /refusing to close/,
    );
  });

  it("no-ops when already opened", async () => {
    const api = mockRest([
      route("GET", "/issues/1", { id: 1, iid: 1, state: "opened" }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.issues.updateIssueStatus({}, { issueId: 1, status: "in_progress" });
    assert.equal(result.noop, true);
  });
});

// ── issues.comment ──────────────────────────────────────────────────

describe("gitlab issues.comment", () => {
  it("creates a note", async () => {
    const api = mockRest([
      route("POST", "/notes", { id: 99 }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.issues.comment({}, { issueId: 1, body: "Hello" });
    assert.equal(result.id, 99);
  });
});

// ── issues.relabelIssue ─────────────────────────────────────────────

describe("gitlab issues.relabelIssue", () => {
  it("uses add_labels / remove_labels REST fields", async () => {
    const api = mockRest([
      route("GET", "/labels", [{ name: "bug", color: "#f00" }, { name: "feat", color: "#0f0" }]),
      route("PUT", "/issues/1", { id: 1, iid: 1, labels: ["bug"] }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.issues.relabelIssue({}, { issueId: 1, add: ["bug"], remove: ["feat"] });
    const putCall = api.log.find((c) => c.method === "PUT");
    assert.ok(putCall.body.add_labels);
    assert.ok(putCall.body.remove_labels);
  });

  it("rejects overlapping add/remove", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.relabelIssue({}, { issueId: 1, add: ["bug"], remove: ["bug"] }),
      /both add and remove/,
    );
  });

  it("no-op returns { id: null, iid, labels: [], noop: true } (keeps id reserved for GitLab's numeric id)", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    const result = await tracker.issues.relabelIssue({}, { issueId: 7, add: [], remove: [] });
    assert.deepEqual(result, { id: null, iid: 7, labels: [], noop: true });
  });
});

// ── listIssues input validation ─────────────────────────────────────

describe("gitlab issues.listIssues input validation", () => {
  it("throws TypeError on non-number first", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}, { first: "50" }),
      /first must be a positive integer/,
    );
  });

  it("throws TypeError on zero or negative limit", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}, { limit: 0 }),
      /limit must be a positive integer/,
    );
    await assert.rejects(
      () => tracker.issues.listIssues({}, { limit: -5 }),
      /limit must be a positive integer/,
    );
  });

  it("throws TypeError on non-integer first (e.g. 1.5)", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}, { first: 1.5 }),
      /first must be a positive integer/,
    );
  });
});

// ── labels.reconcileLabels ──────────────────────────────────────────

describe("gitlab labels.reconcileLabels", () => {
  it("returns {mode, plan} with create + unchanged", async () => {
    const api = mockRest([
      route("GET", "/labels", [{ name: "bug", color: "#f00" }]),
      route("POST", "/labels", { name: "new-label", color: "#888888" }),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.labels.reconcileLabels({}, {
      taxonomy: ["bug", "new-label"],
      apply: true,
    });
    assert.equal(result.mode, "applied");
    assert.ok(result.plan.find((p) => p.action === "unchanged" && p.name === "bug"));
    assert.ok(result.plan.find((p) => p.action === "create" && p.name === "new-label"));
  });

  it("defaults to dry-run", async () => {
    const api = mockRest([
      route("GET", "/labels", []),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.labels.reconcileLabels({}, { taxonomy: ["x"] });
    assert.equal(result.mode, "dry-run");
  });

  it("throws TypeError when apply is not a boolean (string 'true' silently became dry-run before)", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.labels.reconcileLabels({}, { taxonomy: ["x"], apply: "true" }),
      /apply must be a boolean/,
    );
  });

  it("throws TypeError when allowDeprecate is not a boolean", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.labels.reconcileLabels({}, { taxonomy: ["x"], allowDeprecate: 1 }),
      /allowDeprecate must be a boolean/,
    );
  });
});

// ── labels.relabelBulk ──────────────────────────────────────────────

describe("gitlab labels.relabelBulk", () => {
  it("renames via PUT label endpoint", async () => {
    const api = mockRest([
      route("PUT", "/labels/", null),
    ]);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [{ from: "old", to: "new" }],
      apply: true,
    });
    assert.equal(result.mode, "applied");
    assert.equal(result.results[0].success, true);
  });

  it("dry-run returns plan without mutations", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    const result = await tracker.labels.relabelBulk({}, {
      plan: [{ from: "old", to: "new" }],
      apply: false,
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.results[0].action, "would-rename");
  });

  it("throws TypeError when apply is not a boolean", async () => {
    const tracker = makeGitlabTracker(TARGET, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.labels.relabelBulk({}, { plan: [{ from: "a", to: "b" }], apply: "true" }),
      /apply must be a boolean/,
    );
  });
});

// ── resolveLabelMap pagination ──────────────────────────────────────

describe("gitlab resolveLabelMap pagination", () => {
  function paginatedLabelsApi(totalLabels, { perPage = 100 } = {}) {
    return async (method, path, opts = {}) => {
      if (method === "GET" && path.includes("/labels")) {
        const page = opts.query?.page ?? 1;
        const start = (page - 1) * perPage;
        if (start >= totalLabels) return [];
        const end = Math.min(start + perPage, totalLabels);
        const batch = [];
        for (let i = start; i < end; i++) {
          batch.push({ name: `label-${i}`, color: "#888888" });
        }
        return batch;
      }
      // reconcileLabels also dispatches POST/PUT/DELETE. Return nulls.
      return null;
    };
  }

  it("does not throw on exactly MAX_PAGES * MAX_PER_PAGE labels (boundary case)", async () => {
    // 10 pages * 100 per page = exactly 1000 labels. Naive detection
    // flags truncation because the last page is full; the probe
    // request returns [], disambiguating as "complete" not "truncated".
    const api = paginatedLabelsApi(1000);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await assert.doesNotReject(async () => {
      await tracker.labels.reconcileLabels({}, { taxonomy: ["label-0"] });
    });
  });

  it("throws when MAX_PAGES * MAX_PER_PAGE + 1 labels exist (real truncation)", async () => {
    const api = paginatedLabelsApi(1001);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await assert.rejects(
      () => tracker.labels.reconcileLabels({}, { taxonomy: ["label-0"] }),
      /was truncated/,
    );
  });

  it("stops before the probe when last page is not full", async () => {
    // 250 labels: 3 pages (100, 100, 50). Last page is short, so
    // `lastPageFull` stays false and no probe request is made.
    const calls = [];
    const api = async (method, path, opts = {}) => {
      calls.push({ method, path, page: opts.query?.page });
      if (path.includes("/labels")) {
        const page = opts.query?.page ?? 1;
        const start = (page - 1) * 100;
        if (start >= 250) return [];
        const end = Math.min(start + 100, 250);
        const batch = [];
        for (let i = start; i < end; i++) batch.push({ name: `l${i}` });
        return batch;
      }
      return null;
    };
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await tracker.labels.reconcileLabels({}, { taxonomy: ["l0"] });
    const labelGetPages = calls
      .filter((c) => c.method === "GET" && c.path.includes("/labels"))
      .map((c) => c.page);
    assert.deepEqual(labelGetPages, [1, 2, 3]);
  });
});

// ── review paginators: truncation probe parity ──────────────────────

describe("gitlab review paginators truncation probe", () => {
  function paginatedDiscussionsApi(totalDiscussions, { perPage = 100 } = {}) {
    return async (method, path, opts = {}) => {
      if (method === "GET" && path.includes("/merge_requests/") && path.endsWith("/discussions")) {
        const page = opts.query?.page ?? 1;
        const start = (page - 1) * perPage;
        if (start >= totalDiscussions) return [];
        const end = Math.min(start + perPage, totalDiscussions);
        const out = [];
        for (let i = start; i < end; i++) {
          out.push({
            id: `d${i}`,
            notes: [
              { resolvable: true, resolved: false, body: `c${i}`, position: { new_path: "a", new_line: i }, author: { username: "u" } },
            ],
          });
        }
        return out;
      }
      if (method === "GET" && path.includes("/merge_requests/")) {
        return { diff_refs: { head_sha: "sha" }, head_pipeline: { status: "success" } };
      }
      return null;
    };
  }

  it("pollForReview does NOT throw on exactly MAX_PAGES*MAX_PER_PAGE discussions (boundary)", async () => {
    const api = paginatedDiscussionsApi(1000);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await assert.doesNotReject(() => tracker.review.pollForReview({ mrIid: 1 }));
  });

  it("pollForReview throws when more than MAX_PAGES*MAX_PER_PAGE discussions exist", async () => {
    const api = paginatedDiscussionsApi(1001);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await assert.rejects(
      () => tracker.review.pollForReview({ mrIid: 1 }),
      /pollForReview was truncated/,
    );
  });

  it("fetchUnresolvedThreads does NOT throw on the boundary case", async () => {
    const api = paginatedDiscussionsApi(1000);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    const threads = await tracker.review.fetchUnresolvedThreads({ mrIid: 1 });
    assert.equal(threads.length, 1000);
  });

  it("fetchUnresolvedThreads throws when truncated", async () => {
    const api = paginatedDiscussionsApi(1001);
    const tracker = makeGitlabTracker(TARGET, { rest: api });
    await assert.rejects(
      () => tracker.review.fetchUnresolvedThreads({ mrIid: 1 }),
      /fetchUnresolvedThreads was truncated/,
    );
  });
});

// ── normalizeGitlabBase ─────────────────────────────────────────────

describe("normalizeGitlabBase", () => {
  it("prefixes https:// on bare hostnames (ops.config `host` shape)", () => {
    assert.equal(normalizeGitlabBase("gitlab.com"), "https://gitlab.com");
    assert.equal(normalizeGitlabBase("gitlab.acme.internal"), "https://gitlab.acme.internal");
  });

  it("leaves explicit schemes untouched so custom-port + http URLs pass through", () => {
    assert.equal(normalizeGitlabBase("https://gitlab.acme.internal"), "https://gitlab.acme.internal");
    assert.equal(normalizeGitlabBase("http://localhost:8080"), "http://localhost:8080");
  });

  it("trims whitespace before deciding", () => {
    assert.equal(normalizeGitlabBase("  gitlab.com  "), "https://gitlab.com");
  });

  it("produces a base URL that new URL accepts (the original bug)", () => {
    // Before the fix, `new URL("/api/v4/x", "gitlab.com")` threw
    // TypeError: Invalid URL. Normalization is what unblocks self-
    // hosted configs that set `host: "gitlab.acme.internal"`.
    assert.doesNotThrow(() => new URL("/api/v4/test", normalizeGitlabBase("gitlab.com")));
  });
});

// ── Target resolution ───────────────────────────────────────────────

describe("gitlab target resolution", () => {
  it("throws when namespace and repo are missing", async () => {
    const tracker = makeGitlabTracker({}, { rest: mockRest([]) });
    await assert.rejects(
      () => tracker.issues.listIssues({}),
      /requires target\.project_id/,
    );
  });

  it("accepts project_id", async () => {
    const api = mockRest([
      route("GET", "/issues", []),
    ]);
    const tracker = makeGitlabTracker({ project_id: 42 }, { rest: api });
    await tracker.issues.listIssues({});
    assert.ok(api.log[0].path.includes("42"));
  });
});
