// review_github.test.mjs
// Integration tests for the GitHub ReviewProvider impl. Uses the same
// "fake gh on PATH" pattern as ghExec.test.mjs to avoid network and to
// pin the exact response shape. Skipped on Windows (the shim requires
// .cmd scaffolding; real-gh path is exercised by the CI matrix).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGithubReviewProvider } from "../scripts/lib/review/github.mjs";
import { GhGraphqlError } from "../scripts/lib/ghExec.mjs";

const IS_WIN = process.platform === "win32";

// A fake `gh` that writes fixture responses into stdout based on the
// argv it receives. We cannot inspect argv in the Node test directly,
// so the shim looks at `env.FAKE_GH_FIXTURE` (or `$1`) and echoes the
// matching fixture. Tests set the env before each call.
const FAKE_GH = `#!/bin/sh
case "$FAKE_GH_FIXTURE" in
  pr_node_id)
    printf '%s' '{"data":{"repository":{"pullRequest":{"id":"PR_abc123"}}}}'
    ;;
  request_review_ok)
    printf '%s' '{"data":{"requestReviews":{"pullRequest":{"reviewRequests":{"nodes":[{"requestedReviewer":{"login":"copilot-pull-request-reviewer"}}]}}}}}'
    ;;
  poll_all_green_review_on_head)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"commit":{"oid":"HEAD_SHA"},"author":{"login":"copilot-pull-request-reviewer"}}]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_pending)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":null}}]}}}}}'
    ;;
  poll_unresolved_threads)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false},{"isResolved":true},{"isResolved":false}]},"reviews":{"nodes":[]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"FAILURE"}}}]}}}}}'
    ;;
  fetch_threads_mixed)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"T1","isResolved":false,"isOutdated":false,"path":"src/a.js","line":42,"comments":{"nodes":[{"author":{"login":"copilot-pull-request-reviewer"},"body":"prefer const","commit":{"oid":"OLD_SHA"},"createdAt":"2026-04-19T00:00:00Z"}]}},{"id":"T2","isResolved":true,"isOutdated":false,"path":"src/b.js","line":10,"comments":{"nodes":[{"author":{"login":"copilot-pull-request-reviewer"},"body":"resolved already","commit":{"oid":"OLD_SHA"},"createdAt":"2026-04-19T00:00:00Z"}]}},{"id":"T3","isResolved":false,"isOutdated":true,"path":"src/c.js","line":7,"comments":{"nodes":[]}}]}}}}}'
    ;;
  resolve_ok)
    printf '%s' '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
    ;;
  graphql_error)
    printf '%s' '{"data":null,"errors":[{"message":"Field does not exist on type PullRequest"}]}'
    ;;
  *)
    printf '%s' '{"data":null,"errors":[{"message":"fake gh unknown fixture"}]}'
    exit 1
    ;;
esac
`;

async function installFakeGh() {
  const scratch = await mkdtemp(join(tmpdir(), "fake-gh-review-"));
  const scriptPath = join(scratch, "gh");
  await writeFile(scriptPath, FAKE_GH, "utf8");
  await chmod(scriptPath, 0o755);
  return scratch;
}

async function withFakeGh(fixture, fn) {
  const scratch = await installFakeGh();
  const pathBefore = process.env.PATH;
  const fixtureBefore = process.env.FAKE_GH_FIXTURE;
  try {
    process.env.PATH = scratch + ":" + pathBefore;
    process.env.FAKE_GH_FIXTURE = fixture;
    return await fn();
  } finally {
    process.env.PATH = pathBefore;
    if (fixtureBefore === undefined) delete process.env.FAKE_GH_FIXTURE;
    else process.env.FAKE_GH_FIXTURE = fixtureBefore;
    await rm(scratch, { recursive: true, force: true });
  }
}

const skipOpts = IS_WIN
  ? { skip: "windows path shim requires .cmd; covered in CI matrix" }
  : {};

describe("github review provider: requestReview", skipOpts, () => {
  it("succeeds when botIds are provided and gh returns a valid response", async () => {
    await withFakeGh("request_review_ok", async () => {
      const provider = makeGithubReviewProvider();
      const data = await provider.requestReview({
        owner: "ctxr-dev",
        repo: "agent-staff-engineer",
        prNumber: 1,
        headSha: "abc",
        prNodeId: "PR_abc123",
        botIds: ["BOT_kgDOCnlnWA"],
      });
      const logins = data.requestReviews.pullRequest.reviewRequests.nodes.map(
        (n) => n.requestedReviewer.login,
      );
      assert.deepEqual(logins, ["copilot-pull-request-reviewer"]);
    });
  });

  it("refuses when botIds are empty", async () => {
    const provider = makeGithubReviewProvider();
    await assert.rejects(
      () =>
        provider.requestReview({
          owner: "ctxr-dev",
          repo: "agent-staff-engineer",
          prNumber: 1,
          headSha: "abc",
          prNodeId: "PR_abc123",
          botIds: [],
        }),
      /ctx\.botIds is empty/,
    );
  });
});

describe("github review provider: pollForReview", skipOpts, () => {
  it("returns all-green state when review is on HEAD and CI is SUCCESS", async () => {
    await withFakeGh("poll_all_green_review_on_head", async () => {
      const provider = makeGithubReviewProvider();
      const res = await provider.pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      });
      assert.equal(res.ciState, "SUCCESS");
      assert.equal(res.unresolvedCount, 0);
      assert.equal(res.reviewOnHead, true);
    });
  });

  it("returns PENDING when statusCheckRollup is null", async () => {
    await withFakeGh("poll_pending", async () => {
      const provider = makeGithubReviewProvider();
      const res = await provider.pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      });
      assert.equal(res.ciState, "PENDING");
      assert.equal(res.unresolvedCount, 0);
      assert.equal(res.reviewOnHead, false);
    });
  });

  it("counts only unresolved threads and reports CI FAILURE", async () => {
    await withFakeGh("poll_unresolved_threads", async () => {
      const provider = makeGithubReviewProvider();
      const res = await provider.pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      });
      assert.equal(res.ciState, "FAILURE");
      assert.equal(res.unresolvedCount, 2); // two of three are unresolved
      assert.equal(res.reviewOnHead, false);
    });
  });
});

describe("github review provider: fetchUnresolvedThreads", skipOpts, () => {
  it("filters resolved threads and flattens the first comment", async () => {
    await withFakeGh("fetch_threads_mixed", async () => {
      const provider = makeGithubReviewProvider();
      const threads = await provider.fetchUnresolvedThreads({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      });
      assert.equal(threads.length, 2); // T2 is resolved, excluded
      const ids = threads.map((t) => t.id).sort();
      assert.deepEqual(ids, ["T1", "T3"]);
      const t1 = threads.find((t) => t.id === "T1");
      assert.equal(t1.path, "src/a.js");
      assert.equal(t1.line, 42);
      assert.equal(t1.commitSha, "OLD_SHA");
      assert.equal(t1.authorLogin, "copilot-pull-request-reviewer");
      assert.match(t1.body, /prefer const/);
      // T3 has no comments; commitSha/authorLogin/body fall back safely
      const t3 = threads.find((t) => t.id === "T3");
      assert.equal(t3.commitSha, null);
      assert.equal(t3.authorLogin, null);
      assert.equal(t3.body, "");
    });
  });
});

describe("github review provider: resolveThread", skipOpts, () => {
  it("invokes resolveReviewThread mutation with the threadId", async () => {
    await withFakeGh("resolve_ok", async () => {
      const provider = makeGithubReviewProvider();
      const data = await provider.resolveThread({}, "PRRT_abc");
      assert.equal(data.resolveReviewThread.thread.isResolved, true);
    });
  });

  it("rejects an empty threadId without hitting gh", async () => {
    const provider = makeGithubReviewProvider();
    await assert.rejects(
      () => provider.resolveThread({}, ""),
      /threadId must be a non-empty string/,
    );
  });
});

describe("github review provider: GraphQL error surface", skipOpts, () => {
  it("throws GhGraphqlError with the server-reported message", async () => {
    await withFakeGh("graphql_error", async () => {
      const provider = makeGithubReviewProvider();
      try {
        await provider.pollForReview({
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "HEAD_SHA",
        });
        assert.fail("expected GhGraphqlError");
      } catch (err) {
        assert.ok(err instanceof GhGraphqlError, `got ${err?.constructor?.name}`);
        assert.match(err.message, /Field does not exist/);
        assert.ok(Array.isArray(err.errors));
      }
    });
  });
});
