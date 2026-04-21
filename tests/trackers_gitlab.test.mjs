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
