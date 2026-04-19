// review_github.test.mjs
// Integration tests for the GitHub ReviewProvider impl. Uses a fake `gh`
// on PATH (same pattern as ghExec.test.mjs) that both returns scripted
// fixture JSON AND tees every argv + the query body into a log file, so
// tests assert on the actual request the provider sent (not just that
// gh was called at all).
//
// Skipped on Windows because the fake-gh shim here is a POSIX `#!/bin/sh`
// script; Windows needs a .cmd/.bat wrapper or a shim install strategy
// this file doesn't implement. `.github/workflows/ci.yml` currently runs
// on ubuntu-latest only, so there is no Windows coverage for these tests
// today. Adding a Windows CI job is a follow-up if the provider ever
// grows Windows-specific semantics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGithubReviewProvider } from "../scripts/lib/review/github.mjs";
import { GhGraphqlError } from "../scripts/lib/ghExec.mjs";

const IS_WIN = process.platform === "win32";

// The fake gh tees its full argv + any -F/-f values it sees into
// $FAKE_GH_LOG (one line per invocation), then dispatches on
// $FAKE_GH_FIXTURE to emit scripted JSON. Tests read the log to verify
// the provider built the right mutation/query and passed the right
// variables. Without this, a provider mutant that dropped botIds or
// hard-coded threadId would silently pass.
const FAKE_GH = `#!/bin/sh
# Tee the call for assertions. Keep each call on one line for easy
# grepping: argv values (especially GraphQL query text) carry embedded
# newlines, so collapse \\r and \\n to spaces before writing. Without
# this, the "one line per invocation" contract breaks and grep-based
# assertions may match text from other calls.
{
  printf 'ARGV:'
  for a in "$@"; do
    sanitized=$(printf '%s' "$a" | tr '\\r\\n' '  ')
    printf ' %s' "$sanitized"
  done
  printf '\\n'
} >> "$FAKE_GH_LOG"
# Sequence mode: when FAKE_GH_SEQUENCE is set, pick the Nth fixture by
# counting call-log lines. The counter persists across invocations of
# the shim because the log file grows monotonically. Provider methods
# that paginate make multiple gh calls per user-level invocation; this
# lets a single withFakeGh() session script all of them in order.
if [ -n "$FAKE_GH_SEQUENCE" ]; then
  call_no=$(wc -l < "$FAKE_GH_LOG" | tr -d ' ')
  FAKE_GH_FIXTURE=$(printf '%s' "$FAKE_GH_SEQUENCE" | awk -v n="$call_no" '{ k = split($0, arr, ","); if (n <= k) print arr[n] }')
fi
case "$FAKE_GH_FIXTURE" in
  pr_node_id)
    printf '%s' '{"data":{"repository":{"pullRequest":{"id":"PR_abc123"}}}}'
    ;;
  request_review_ok)
    printf '%s' '{"data":{"requestReviews":{"pullRequest":{"reviewRequests":{"nodes":[{"requestedReviewer":{"login":"copilot-pull-request-reviewer"}}]}}}}}'
    ;;
  poll_all_green_review_on_head)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"commit":{"oid":"HEAD_SHA"},"author":{"__typename":"Bot","login":"copilot-pull-request-reviewer"}}]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_pending)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":null}}]}}}}}'
    ;;
  poll_unresolved_threads)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false},{"isResolved":true},{"isResolved":false}]},"reviews":{"nodes":[]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"FAILURE"}}}]}}}}}'
    ;;
  poll_error)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"ERROR"}}}]}}}}}'
    ;;
  poll_stale_ctx_head)
    # Review posted on the PR's CURRENT HEAD (FRESH_SHA), but the caller
    # passed a stale ctx.headSha (STALE_SHA). pollForReview should still
    # report reviewOnHead=true because it uses the PR's fetched HEAD,
    # not ctx.headSha, as ground truth.
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"commit":{"oid":"FRESH_SHA"},"author":{"__typename":"Bot","login":"copilot-pull-request-reviewer"}}]},"commits":{"nodes":[{"commit":{"oid":"FRESH_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_human_review_on_head_only)
    # A teammate (User, not Bot) reviewed HEAD, but the external
    # reviewer (Copilot) has not. reviewOnHead should be false so the
    # iteration loop keeps polling for the external reviewer's verdict.
    # Regression test for review-round-4 T14.
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"commit":{"oid":"HEAD_SHA"},"author":{"__typename":"User","login":"meshin-dev"}}]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_bot_login_filter)
    # Two bot reviews on HEAD: one is the configured bot
    # (copilot-pull-request-reviewer), one is a different bot
    # (other-bot). With ctx.botLogins=["copilot-pull-request-reviewer"],
    # reviewOnHead must be true ONLY because of the matching login;
    # an unrelated bot on HEAD must not satisfy the gate.
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"commit":{"oid":"HEAD_SHA"},"author":{"__typename":"Bot","login":"other-bot"}},{"commit":{"oid":"HEAD_SHA"},"author":{"__typename":"Bot","login":"copilot-pull-request-reviewer"}}]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_bot_login_mismatch)
    # Same shape as above but ONLY other-bot reviewed HEAD. With
    # ctx.botLogins targeted at copilot, reviewOnHead must be false.
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"commit":{"oid":"HEAD_SHA"},"author":{"__typename":"Bot","login":"other-bot"}}]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_all_resolved_page1_with_next)
    # Page 1: all resolved. pageInfo says hasNextPage=true.
    # pollForReview must call out to page 2 before declaring unresolvedCount=0.
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":true},{"isResolved":true}],"pageInfo":{"hasNextPage":true,"endCursor":"CURSOR_PAGE1"}},"reviews":{"nodes":[{"commit":{"oid":"HEAD_SHA"},"author":{"__typename":"Bot","login":"copilot-pull-request-reviewer"}}]},"commits":{"nodes":[{"commit":{"oid":"HEAD_SHA","statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
    ;;
  poll_page2_has_unresolved)
    # Page 2 surfaces an unresolved. Paired with poll_all_resolved_page1_with_next
    # via FAKE_GH_SEQUENCE. pollForReview's count helper short-circuits here.
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":true},{"isResolved":false}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    ;;
  fetch_threads_mixed)
    printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"T1","isResolved":false,"isOutdated":false,"path":"src/a.js","line":42,"comments":{"nodes":[{"author":{"__typename":"Bot","login":"copilot-pull-request-reviewer"},"body":"prefer const","commit":{"oid":"OLD_SHA"},"createdAt":"2026-04-19T00:00:00Z"}]}},{"id":"T2","isResolved":true,"isOutdated":false,"path":"src/b.js","line":10,"comments":{"nodes":[{"author":{"__typename":"Bot","login":"copilot-pull-request-reviewer"},"body":"resolved already","commit":{"oid":"OLD_SHA"},"createdAt":"2026-04-19T00:00:00Z"}]}},{"id":"T3","isResolved":false,"isOutdated":true,"path":"src/c.js","line":7,"comments":{"nodes":[]}},{"id":"T4","isResolved":false,"isOutdated":false,"path":"src/u.js","line":1,"comments":{"nodes":[{"author":null,"body":"unicode: e accent and CJK chars","commit":{"oid":"SHA_U"},"createdAt":"2026-04-19T00:00:00Z"}]}}]}}}}}'
    ;;
  resolve_ok)
    printf '%s' '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
    ;;
  ci_state_success)
    printf '%s' '{"data":{"repository":{"pullRequest":{"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
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
  const logPath = join(scratch, "gh.log");
  await writeFile(scriptPath, FAKE_GH, "utf8");
  await writeFile(logPath, "", "utf8");
  await chmod(scriptPath, 0o755);
  return { scratch, logPath };
}

// Runs fn with a fresh fake-gh + log, returning the log contents so
// callers can assert on the exact argv the provider sent. Saves and
// restores process.env.PATH / FAKE_GH_FIXTURE / FAKE_GH_LOG even on
// async rejection. Sequential use only; node --test defaults are fine.
async function withFakeGh(fixture, fn) {
  const { scratch, logPath } = await installFakeGh();
  const pathBefore = process.env.PATH;
  const fixBefore = process.env.FAKE_GH_FIXTURE;
  const logBefore = process.env.FAKE_GH_LOG;
  try {
    // PATH may be unset on constrained test runners. Use just the
    // shim directory in that case so we don't introduce a trailing
    // empty PATH entry (which on POSIX means "current directory" and
    // breaks hermeticity). The restore logic below still distinguishes
    // "was unset" (delete) from "was set" (assign).
    process.env.PATH =
      pathBefore === undefined ? scratch : scratch + ":" + pathBefore;
    process.env.FAKE_GH_FIXTURE = fixture;
    process.env.FAKE_GH_LOG = logPath;
    const result = await fn();
    const log = await readFile(logPath, "utf8");
    return { result, log };
  } finally {
    // Restoring via `process.env.PATH = undefined` would set the
    // literal string "undefined" and pollute subsequent tests.
    // Same pattern for the other two env vars.
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    if (fixBefore === undefined) delete process.env.FAKE_GH_FIXTURE;
    else process.env.FAKE_GH_FIXTURE = fixBefore;
    if (logBefore === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = logBefore;
    await rm(scratch, { recursive: true, force: true });
  }
}

// Variant of withFakeGh that scripts a sequence of fixtures. The shim
// picks the Nth fixture by counting prior calls in the log file. Use
// when the method under test paginates (multiple gh calls per one
// provider-method invocation).
async function withFakeGhSequence(fixtures, fn) {
  const { scratch, logPath } = await installFakeGh();
  const pathBefore = process.env.PATH;
  const fixBefore = process.env.FAKE_GH_FIXTURE;
  const seqBefore = process.env.FAKE_GH_SEQUENCE;
  const logBefore = process.env.FAKE_GH_LOG;
  try {
    process.env.PATH = scratch + ":" + (pathBefore ?? "");
    process.env.FAKE_GH_FIXTURE = ""; // shim falls back to sequence
    process.env.FAKE_GH_SEQUENCE = fixtures.join(",");
    process.env.FAKE_GH_LOG = logPath;
    const result = await fn();
    const log = await readFile(logPath, "utf8");
    return { result, log };
  } finally {
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    if (fixBefore === undefined) delete process.env.FAKE_GH_FIXTURE;
    else process.env.FAKE_GH_FIXTURE = fixBefore;
    if (seqBefore === undefined) delete process.env.FAKE_GH_SEQUENCE;
    else process.env.FAKE_GH_SEQUENCE = seqBefore;
    if (logBefore === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = logBefore;
    await rm(scratch, { recursive: true, force: true });
  }
}

const skipOpts = IS_WIN
  ? { skip: "windows path shim requires .cmd; no Windows CI job exists today" }
  : {};

describe("github review provider: requestReview", skipOpts, () => {
  it("succeeds and actually transmits the resolved botIds into the mutation text", async () => {
    const { result, log } = await withFakeGh("request_review_ok", () =>
      makeGithubReviewProvider().requestReview({
        owner: "ctxr-dev",
        repo: "agent-staff-engineer",
        prNumber: 1,
        headSha: "abc",
        prNodeId: "PR_abc123",
        botIds: ["BOT_kgDOCnlnWA"],
      }),
    );
    const logins = result.requestReviews.pullRequest.reviewRequests.nodes.map(
      (n) => n.requestedReviewer.login,
    );
    assert.deepEqual(logins, ["copilot-pull-request-reviewer"]);
    // Argv must show the query including botIds and the prId variable.
    assert.match(log, /api graphql/);
    assert.match(log, /requestReviews/, "mutation name should appear in argv");
    assert.match(log, /"BOT_kgDOCnlnWA"/, "botIds must be inlined into the query");
    assert.match(log, /prId=PR_abc123/, "prId must be passed via -F");
  });

  it("passes every supplied botId through (would catch a silent drop)", async () => {
    const { log } = await withFakeGh("request_review_ok", () =>
      makeGithubReviewProvider().requestReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "abc",
        prNodeId: "PR_xyz",
        botIds: ["BOT_first", "BOT_second"],
      }),
    );
    assert.match(log, /"BOT_first"/);
    assert.match(log, /"BOT_second"/);
  });

  it("refuses when botIds are empty (pre-call guard, no gh invocation)", async () => {
    const provider = makeGithubReviewProvider();
    await assert.rejects(
      () =>
        provider.requestReview({
          owner: "o",
          repo: "r",
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
    const { result } = await withFakeGh("poll_all_green_review_on_head", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result.ciState, "SUCCESS");
    assert.equal(result.unresolvedCount, 0);
    assert.equal(result.reviewOnHead, true);
  });

  it("returns PENDING when statusCheckRollup is null", async () => {
    const { result } = await withFakeGh("poll_pending", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result.ciState, "PENDING");
    assert.equal(result.reviewOnHead, false);
  });

  it("returns ERROR when statusCheckRollup.state is ERROR", async () => {
    const { result } = await withFakeGh("poll_error", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result.ciState, "ERROR");
  });

  it("counts only unresolved threads and reports CI FAILURE", async () => {
    const { result } = await withFakeGh("poll_unresolved_threads", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result.ciState, "FAILURE");
    assert.equal(result.unresolvedCount, 2);
    assert.equal(result.reviewOnHead, false);
  });

  it("reviewOnHead=false when only a human reviewed HEAD (external reviewer has not)", async () => {
    // Regression test for review-round-4 T14: a teammate review on HEAD
    // must NOT satisfy the external-reviewer gate, because the iteration
    // loop is designed to wait for Copilot's verdict. A mutant that
    // accepted any review would set reviewOnHead=true here and exit
    // early.
    const { result } = await withFakeGh("poll_human_review_on_head_only", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result.reviewOnHead, false, "human-only review on HEAD must not satisfy the gate");
    assert.equal(result.ciState, "SUCCESS");
  });

  it("filters reviewOnHead by ctx.botLogins when provided (matching login wins)", async () => {
    const { result } = await withFakeGh("poll_bot_login_filter", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
        botLogins: ["copilot-pull-request-reviewer"],
      }),
    );
    assert.equal(result.reviewOnHead, true, "matching bot login should satisfy the gate");
  });

  it("ctx.botLogins filter is case-insensitive (GitHub logins are)", async () => {
    // poll_bot_login_filter fixture has author login
    // "copilot-pull-request-reviewer" (lowercase). Config may carry
    // mixed casing; ensure the filter treats them equal.
    const { result } = await withFakeGh("poll_bot_login_filter", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
        botLogins: ["Copilot-Pull-Request-Reviewer"],
      }),
    );
    assert.equal(result.reviewOnHead, true, "casing difference must not break the match");
  });

  it("filters reviewOnHead by ctx.botLogins when provided (non-matching login rejected)", async () => {
    const { result } = await withFakeGh("poll_bot_login_mismatch", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
        botLogins: ["copilot-pull-request-reviewer"],
      }),
    );
    assert.equal(result.reviewOnHead, false, "unrelated bot on HEAD must not satisfy the gate when botLogins are explicit");
  });

  it("uses the PR's fetched HEAD, not ctx.headSha, when classifying review-on-head", async () => {
    // Regression test for review-round-3 T10: caller passed a stale
    // ctx.headSha. The review is on the PR's current HEAD. Without the
    // fix, reviewOnHead would wrongly be false because comparison used
    // the stale ctx value.
    const { result } = await withFakeGh("poll_stale_ctx_head", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "STALE_SHA",
      }),
    );
    assert.equal(result.reviewOnHead, true, "should trust the PR's fetched HEAD, not stale ctx");
    assert.equal(result.ciState, "SUCCESS");
  });

  it("pages reviewThreads when page 1 is all-resolved but hasNextPage=true (unresolved surfaces on page 2)", async () => {
    // Regression test for review-round-8 T29: without pagination, a
    // PR with unresolved threads only past page 1 would report
    // unresolvedCount=0 and trip the exit gate. The paged helper must
    // detect page 2's unresolved entry.
    const { result, log } = await withFakeGhSequence(
      ["poll_all_resolved_page1_with_next", "poll_page2_has_unresolved"],
      () =>
        makeGithubReviewProvider().pollForReview({
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "HEAD_SHA",
        }),
    );
    assert.equal(
      result.unresolvedCount > 0,
      true,
      "unresolved on page 2 must surface; current impl counts >=1",
    );
    // Two gh calls: first page + continuation page.
    const callCount = (log.match(/^ARGV:/gm) || []).length;
    assert.equal(callCount, 2, `expected 2 gh calls (pagination); got ${callCount}`);
  });

  it("transmits owner/repo/number variables and the reviewThreads query", async () => {
    const { log } = await withFakeGh("poll_all_green_review_on_head", () =>
      makeGithubReviewProvider().pollForReview({
        owner: "ctxr-dev",
        repo: "agent-staff-engineer",
        prNumber: 42,
        headSha: "HEAD_SHA",
      }),
    );
    assert.match(log, /reviewThreads/);
    assert.match(log, /statusCheckRollup/);
    assert.match(log, /owner=ctxr-dev/);
    assert.match(log, /name=agent-staff-engineer/);
    assert.match(log, /number=42/);
  });
});

describe("github review provider: fetchUnresolvedThreads", skipOpts, () => {
  it("filters resolved threads, flattens the first comment, tolerates null author + unicode body", async () => {
    const { result } = await withFakeGh("fetch_threads_mixed", () =>
      makeGithubReviewProvider().fetchUnresolvedThreads({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result.length, 3); // T2 is resolved, excluded
    const byId = Object.fromEntries(result.map((t) => [t.id, t]));
    assert.ok(byId.T1 && byId.T3 && byId.T4);
    assert.equal(byId.T1.path, "src/a.js");
    assert.equal(byId.T1.line, 42);
    assert.equal(byId.T1.commitSha, "OLD_SHA");
    assert.equal(byId.T1.authorLogin, "copilot-pull-request-reviewer");
    assert.equal(byId.T1.isOutdated, false);
    // T3: isOutdated=true in fixture; no comments
    assert.equal(byId.T3.isOutdated, true);
    assert.equal(byId.T3.commitSha, null);
    assert.equal(byId.T3.authorLogin, null);
    assert.equal(byId.T3.body, "");
    // T4: present comment but null author, unicode body
    assert.equal(byId.T4.isOutdated, false);
    assert.equal(byId.T4.authorLogin, null);
    assert.equal(byId.T4.commitSha, "SHA_U");
    assert.match(byId.T4.body, /unicode/);
    assert.match(byId.T4.body, /CJK/);
  });
});

describe("github review provider: resolveThread", skipOpts, () => {
  it("actually passes the threadId to the mutation (argv check)", async () => {
    const { result, log } = await withFakeGh("resolve_ok", () =>
      makeGithubReviewProvider().resolveThread({}, "PRRT_abc"),
    );
    assert.equal(result.resolveReviewThread.thread.isResolved, true);
    assert.match(log, /resolveReviewThread/);
    assert.match(log, /tid=PRRT_abc/, "threadId must be passed through to the mutation");
  });

  it("rejects an empty threadId without hitting gh", async () => {
    const provider = makeGithubReviewProvider();
    await assert.rejects(
      () => provider.resolveThread({}, ""),
      /threadId must be a non-empty string/,
    );
  });
});

describe("github review provider: ciStateOnHead (narrow query)", skipOpts, () => {
  it("fetches only the HEAD commit statusCheckRollup, not the full poll payload", async () => {
    const { result, log } = await withFakeGh("ci_state_success", () =>
      makeGithubReviewProvider().ciStateOnHead({
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "HEAD_SHA",
      }),
    );
    assert.equal(result, "SUCCESS");
    assert.match(log, /statusCheckRollup/);
    // Narrow query does NOT ask for reviewThreads or reviews.
    assert.doesNotMatch(log, /reviewThreads/);
    assert.doesNotMatch(log, /reviews\(last/);
  });
});

describe("github review provider: GraphQL error surface", skipOpts, () => {
  it("throws GhGraphqlError with the server-reported message", async () => {
    try {
      await withFakeGh("graphql_error", () =>
        makeGithubReviewProvider().pollForReview({
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "HEAD_SHA",
        }),
      );
      assert.fail("expected GhGraphqlError");
    } catch (err) {
      assert.ok(err instanceof GhGraphqlError, `got ${err?.constructor?.name}`);
      assert.match(err.message, /Field does not exist/);
      assert.ok(Array.isArray(err.errors));
    }
  });
});
