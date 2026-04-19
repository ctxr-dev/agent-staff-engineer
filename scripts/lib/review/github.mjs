// lib/review/github.mjs
// GitHub implementation of the ReviewProvider contract. Every operation
// wraps a `gh api graphql` call captured in the pr-iteration runbook
// (requestReviews, reviewThreads, resolveReviewThread, statusCheckRollup).
//
// Why GraphQL and not REST: the runbook's step 4 documents that the REST
// `POST /repos/.../requested_reviewers` endpoint silently no-ops for bots
// (it returns 200 but never requests Copilot). The GraphQL `requestReviews`
// mutation with `botIds` is the only mechanism that actually triggers a
// bot review; the whole loop is built on top of that mutation.
//
// botIds capture: the Copilot bot has a stable GraphQL node ID per repo
// (e.g. "BOT_kgDOCnlnWA"). The agent captures it once, typically from the
// sibling repo's recent reviews, and passes it in ctx.botIds for every
// round thereafter. See rules/pr-iteration.md for the capture recipe.

import { ghGraphqlMutation, ghGraphqlQuery } from "../ghExec.mjs";
import { REVIEW_PROVIDER_METHODS } from "./provider.mjs";

/** @returns {object} a ReviewProvider impl bound to gh CLI */
export function makeGithubReviewProvider() {
  const impl = {
    requestReview: githubRequestReview,
    pollForReview: githubPollForReview,
    fetchUnresolvedThreads: githubFetchUnresolvedThreads,
    resolveThread: githubResolveThread,
    ciStateOnHead: githubCiStateOnHead,
  };
  // Construction-time coverage assert: if REVIEW_PROVIDER_METHODS grows a
  // new entry and this file forgets to wire it, fail loudly here rather
  // than letting the skill hit a bare `x is not a function` at runtime.
  const missing = REVIEW_PROVIDER_METHODS.filter((m) => typeof impl[m] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `makeGithubReviewProvider: missing ReviewProvider methods [${missing.join(", ")}]; wire them in or update REVIEW_PROVIDER_METHODS`,
    );
  }
  return impl;
}

async function githubRequestReview(ctx) {
  // Validate ctx.botIds BEFORE resolving prNodeId. resolvePrNodeId may
  // trigger an extra GraphQL call; there's no point paying for it when
  // the mutation is guaranteed to fail downstream on empty botIds.
  const botIds = ctx.botIds ?? [];
  if (botIds.length === 0) {
    throw new Error(
      "github review: ctx.botIds is empty; capture the bot node ID (see rules/pr-iteration.md) before calling requestReview",
    );
  }
  // Validate each element: GitHub's requestReviews mutation rejects
  // null/undefined/empty-string ids with an opaque "expected String"
  // error. Catch the offending index here with a clear message so
  // the caller sees exactly which botId was bad.
  const validatedBotIds = botIds.map((id, i) => {
    if (typeof id !== "string") {
      throw new TypeError(
        `github review: ctx.botIds[${i}] must be a non-empty string GraphQL node ID; got ${String(id)}`,
      );
    }
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new TypeError(
        `github review: ctx.botIds[${i}] must be a non-empty string GraphQL node ID; got ${JSON.stringify(id)}`,
      );
    }
    return trimmed;
  });
  const prNodeId = ctx.prNodeId ?? (await resolvePrNodeId(ctx));
  // botIds is inlined into the query text because `gh api graphql -F` does
  // not have clean ergonomics for array values. Each id is JSON-encoded so
  // quoting is correct and prevents any stray shell/GraphQL metacharacter
  // from escaping the string context. The prNodeId goes via a typed var.
  const botIdsList = validatedBotIds.map((id) => JSON.stringify(id)).join(", ");
  const mutation = `
    mutation($prId: ID!) {
      requestReviews(input: {
        pullRequestId: $prId
        botIds: [${botIdsList}]
        union: true
      }) {
        pullRequest {
          reviewRequests(first: 10) {
            nodes { requestedReviewer { ... on Bot { login } } }
          }
        }
      }
    }
  `;
  return ghGraphqlMutation(mutation, { prId: prNodeId });
}

async function githubPollForReview(ctx) {
  const { owner, repo, prNumber, headSha, botLogins } = ctx;
  // First page fetches threads + reviews + commits in one round-trip.
  // Pagination only kicks in when page 1 is all-resolved AND more pages
  // exist — the common case (small PRs) still does exactly one query.
  // Review history is pulled with last:50 (up from last:10) so long-
  // running PRs with many re-review rounds don't fall off the window.
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { isResolved }
            pageInfo { hasNextPage endCursor }
          }
          reviews(last: 50) {
            nodes {
              commit { oid }
              author { __typename login }
            }
          }
          commits(last: 1) {
            nodes { commit { oid statusCheckRollup { state } } }
          }
        }
      }
    }
  `;
  const data = await ghGraphqlQuery(query, {
    owner,
    name: repo,
    number: prNumber,
  });
  const pr = data.repository.pullRequest;
  const firstPage = pr.reviewThreads;
  let unresolvedCount = firstPage.nodes.filter((t) => !t.isResolved).length;
  // If page 1 is all-resolved but more pages exist, page through the
  // tail until we see any unresolved (sufficient signal to exit the
  // count loop) or confirm none. Without this, a PR with >100 threads
  // where all unresolved happen to sit past page 1 would report
  // unresolvedCount=0 and let the iteration loop exit prematurely.
  if (unresolvedCount === 0 && firstPage.pageInfo?.hasNextPage) {
    unresolvedCount = await countUnresolvedBeyondFirstPage(
      { owner, repo, prNumber },
      firstPage.pageInfo.endCursor,
    );
  }
  const rawState = pr.commits.nodes[0]?.commit?.statusCheckRollup?.state;
  // Prefer the PR's server-side current HEAD SHA over `ctx.headSha`:
  // if the caller forgot to refresh `ctx` after a push, the ctx value
  // is stale and this comparison would wrongly report
  // `reviewOnHead: false`, keeping the loop polling. Fall back to
  // ctx.headSha only when the query didn't surface a commit (rare).
  const prHeadSha = pr.commits.nodes[0]?.commit?.oid ?? headSha;
  // `reviewOnHead` MUST be true only for the configured external
  // reviewer, not any review. Without this filter a human review on
  // HEAD (project owner, teammate) trips the gate and the iteration
  // loop exits before Copilot has caught up to the new SHA.
  // Filter precedence:
  //   1. ctx.botLogins non-empty -> author.login must be one of those.
  //   2. Otherwise accept any `Bot`-typed author (keeps the code
  //      useful for callers that don't want login-level precision).
  // Comparison is case-insensitive because GitHub logins are
  // case-insensitive and config may carry mixed casing
  // ("Copilot-pull-request-reviewer" etc).
  const lowerBotLogins =
    Array.isArray(botLogins) && botLogins.length > 0
      ? new Set(botLogins.map((x) => String(x).toLowerCase()))
      : null;
  const reviewOnHead = pr.reviews.nodes.some((r) => {
    if ((r.commit?.oid ?? null) !== prHeadSha) return false;
    const author = r.author || {};
    if (lowerBotLogins) {
      return (
        typeof author.login === "string" &&
        lowerBotLogins.has(author.login.toLowerCase())
      );
    }
    return author.__typename === "Bot";
  });
  return { ciState: normalizeCiState(rawState), unresolvedCount, reviewOnHead };
}

// GitHub's StatusState enum carries several values the ReviewProvider
// contract does NOT surface (EXPECTED, PENDING_EXPECTED, plus historical
// casing variants). Fold everything that isn't one of the four
// documented terminal/transitional states into PENDING so downstream
// comparisons (exit gates, if/else on ci_done) don't silently mis-bucket
// an in-flight run.
function normalizeCiState(raw) {
  if (raw === "SUCCESS" || raw === "FAILURE" || raw === "ERROR" || raw === "PENDING") {
    return raw;
  }
  return "PENDING";
}

// Hard cap on paginated `reviewThreads` fetches. 10 pages * 100 per
// page = 1000 threads. PRs larger than that are pathological; fail
// loud rather than silently truncate.
const MAX_REVIEW_THREAD_PAGES = 10;

async function githubFetchUnresolvedThreads(ctx) {
  const { owner, repo, prNumber } = ctx;
  // Paginate through every reviewThreads page so the skill sees every
  // unresolved thread on a large PR. Without this, threads past page 1
  // would never be triaged or resolved and the loop could never
  // converge to unresolved=0.
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              id isResolved isOutdated path line
              comments(first: 5) {
                nodes { author { login } body commit { oid } createdAt }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const all = [];
  let after = null;
  let hasNext = true;
  let page = 0;
  while (hasNext) {
    page += 1;
    if (page > MAX_REVIEW_THREAD_PAGES) {
      throw new Error(
        `githubFetchUnresolvedThreads: exceeded ${MAX_REVIEW_THREAD_PAGES} pages of review threads for ${owner}/${repo}#${prNumber}; refusing to silently truncate results`,
      );
    }
    const data = await ghGraphqlQuery(query, {
      owner,
      name: repo,
      number: prNumber,
      after,
    });
    const rt = data.repository.pullRequest.reviewThreads;
    all.push(...rt.nodes);
    hasNext = Boolean(rt.pageInfo?.hasNextPage);
    after = rt.pageInfo?.endCursor ?? null;
  }
  return all
    .filter((t) => !t.isResolved)
    .map((t) => {
      const firstComment = t.comments.nodes[0] ?? {};
      return {
        id: t.id,
        path: t.path,
        line: t.line,
        // GitHub's `isOutdated` flag: the anchor line has moved since
        // the comment was posted. A strong signal for the stale-triage
        // heuristic in rules/pr-iteration.md ("superseded SHA" / "code
        // changed under the thread"). Surfaced so the skill can auto-
        // classify outdated threads without re-deriving the fact.
        isOutdated: Boolean(t.isOutdated),
        commitSha: firstComment.commit?.oid ?? null,
        authorLogin: firstComment.author?.login ?? null,
        body: firstComment.body ?? "",
      };
    });
}

async function githubResolveThread(_ctx, threadId) {
  // Reject whitespace-only threadIds in addition to empty strings,
  // matching the stricter pattern botIds validation uses. Without
  // this, "   " would be sent to GitHub and bounce as an opaque
  // GraphQL "expected String" error.
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new TypeError("resolveThread: threadId must be a non-empty string");
  }
  const mutation = `
    mutation($tid: ID!) {
      resolveReviewThread(input: { threadId: $tid }) {
        thread { isResolved }
      }
    }
  `;
  return ghGraphqlMutation(mutation, { tid: threadId });
}

async function githubCiStateOnHead(ctx) {
  // Narrow query: only the HEAD commit's statusCheckRollup.state. Separate
  // from pollForReview so callers that need just the CI signal don't drag
  // along the full review-threads + reviews fetch.
  const { owner, repo, prNumber } = ctx;
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
        }
      }
    }
  `;
  const data = await ghGraphqlQuery(query, {
    owner,
    name: repo,
    number: prNumber,
  });
  const raw = data.repository.pullRequest.commits.nodes[0]?.commit?.statusCheckRollup?.state;
  return normalizeCiState(raw);
}

async function resolvePrNodeId({ owner, repo, prNumber }) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { id }
      }
    }
  `;
  const data = await ghGraphqlQuery(query, {
    owner,
    name: repo,
    number: prNumber,
  });
  return data.repository.pullRequest.id;
}

/**
 * Page through reviewThreads starting after `startCursor` and return the
 * count of unresolved threads, short-circuiting as soon as any unresolved
 * is seen (>= 1 is enough signal for pollForReview's gate). Throws if
 * pagination would exceed MAX_REVIEW_THREAD_PAGES. Only used when
 * pollForReview's first page is all-resolved but hasNextPage is true.
 *
 * Returns the count of unresolved threads found on pages 2..N. Page 1's
 * count was already known to be 0 when this is invoked.
 */
async function countUnresolvedBeyondFirstPage({ owner, repo, prNumber }, startCursor) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            nodes { isResolved }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  let after = startCursor;
  let page = 1; // page 1 already consumed by the caller
  let unresolved = 0;
  while (after) {
    page += 1;
    if (page > MAX_REVIEW_THREAD_PAGES) {
      throw new Error(
        `countUnresolvedBeyondFirstPage: exceeded ${MAX_REVIEW_THREAD_PAGES} pages for ${owner}/${repo}#${prNumber}; refusing to silently truncate`,
      );
    }
    const data = await ghGraphqlQuery(query, {
      owner,
      name: repo,
      number: prNumber,
      after,
    });
    const rt = data.repository.pullRequest.reviewThreads;
    const pageUnresolved = rt.nodes.filter((t) => !t.isResolved).length;
    if (pageUnresolved > 0) {
      // Any unresolved is enough signal; the exact count doesn't matter
      // for the gate (unresolvedCount > 0 blocks exit either way).
      return unresolved + pageUnresolved;
    }
    if (!rt.pageInfo?.hasNextPage) return unresolved;
    after = rt.pageInfo.endCursor ?? null;
  }
  return unresolved;
}
