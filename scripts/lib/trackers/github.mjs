// lib/trackers/github.mjs
// GitHub implementation of the Tracker contract. The review namespace
// is fully implemented against `gh api graphql` mutations captured in
// skills/pr-iteration/runbook.md (requestReviews, reviewThreads,
// resolveReviewThread, statusCheckRollup). The issues / projects /
// labels namespaces are currently stubbed; the github-sync contract
// (skills/tracker-sync/SKILL.md on this branch, formerly github-sync)
// still governs those operations at the agent-runtime level. They
// will move onto this Tracker surface as the skill's prose operations
// get wired into code.
//
// Why GraphQL and not REST for review: the runbook's step 4 documents
// that the REST `POST /repos/.../requested_reviewers` endpoint silently
// no-ops for bots (returns 200 but never requests Copilot). The
// GraphQL `requestReviews` mutation with `botIds` is the only mechanism
// that actually triggers a bot review.
//
// botIds capture: the Copilot bot has a stable GraphQL node ID per
// repo (e.g. "BOT_kgDOCnlnWA"). The agent captures it once per repo
// and passes it in ctx.botIds for every round. See rules/pr-iteration.md
// for the capture recipe.

import { ghGraphqlMutation, ghGraphqlQuery } from "../ghExec.mjs";
import {
  NotSupportedError,
  REVIEW_METHODS,
  TRACKER_NAMESPACES,
} from "./tracker.mjs";

/**
 * Build a GitHub Tracker bound to a tracker-target config.
 *
 * @param {object} [target] parsed ops.config.json trackers.{dev|release}
 *   entry. Optional because the review-iteration methods take all their
 *   runtime fields (owner, repo, prNumber, headSha, botIds, botLogins)
 *   via ctx. Passed through so issues/projects/labels impls, when they
 *   land, can default from the config.
 * @returns {object} Tracker shape: { review, issues, projects, labels, kind, target }
 */
export function makeGithubTracker(target = {}) {
  const review = {
    requestReview: githubRequestReview,
    pollForReview: githubPollForReview,
    fetchUnresolvedThreads: githubFetchUnresolvedThreads,
    resolveThread: githubResolveThread,
    ciStateOnHead: githubCiStateOnHead,
  };
  // Construction-time coverage assert: if REVIEW_METHODS grows a new
  // entry and this file forgets to wire it, fail loudly here rather
  // than letting the skill hit a bare `x is not a function` at runtime.
  const missing = REVIEW_METHODS.filter((m) => typeof review[m] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `makeGithubTracker: missing review methods [${missing.join(", ")}]; wire them or update REVIEW_METHODS`,
    );
  }
  return {
    kind: "github",
    target,
    review,
    issues: makeStubNamespace("github", "issues"),
    projects: makeStubNamespace("github", "projects"),
    labels: makeStubNamespace("github", "labels"),
  };
}

/**
 * Build a namespace full of NotSupportedError-throwing methods. Used
 * by this file's issues/projects/labels placeholders AND by the
 * jira/linear/gitlab stub trackers. Kept here (rather than imported
 * from stub.mjs) so this file is self-contained for the github case.
 *
 * @param {string} kind tracker kind
 * @param {string} namespace one of the keys of TRACKER_NAMESPACES
 */
function makeStubNamespace(kind, namespace) {
  const methods = TRACKER_NAMESPACES[namespace];
  if (!methods) {
    throw new Error(`makeStubNamespace: unknown namespace '${namespace}'`);
  }
  const ns = {};
  for (const op of methods) {
    ns[op] = async () => {
      throw new NotSupportedError(
        `tracker '${kind}' does not implement '${namespace}.${op}' yet; see skills/tracker-sync/SKILL.md for the current surface`,
        { kind, op, namespace },
      );
    };
  }
  return ns;
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
  if (unresolvedCount === 0 && firstPage.pageInfo?.hasNextPage) {
    unresolvedCount = await countUnresolvedBeyondFirstPage(
      { owner, repo, prNumber },
      firstPage.pageInfo.endCursor,
    );
  }
  const rawState = pr.commits.nodes[0]?.commit?.statusCheckRollup?.state;
  // Prefer the PR's server-side current HEAD SHA over `ctx.headSha`:
  // if the caller forgot to refresh ctx after a push, the ctx value
  // is stale and this comparison would wrongly report
  // `reviewOnHead: false`, keeping the loop polling.
  const prHeadSha = pr.commits.nodes[0]?.commit?.oid ?? headSha;
  // `reviewOnHead` MUST be true only for the configured external
  // reviewer, not any review. Without this filter a human review on
  // HEAD (project owner, teammate) trips the gate and the iteration
  // loop exits before Copilot has caught up to the new SHA.
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

// GitHub's StatusState enum carries several values the review contract
// does NOT surface. Fold anything that isn't one of the four documented
// terminal/transitional states into PENDING so downstream comparisons
// don't silently mis-bucket an in-flight run.
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
        isOutdated: Boolean(t.isOutdated),
        commitSha: firstComment.commit?.oid ?? null,
        authorLogin: firstComment.author?.login ?? null,
        body: firstComment.body ?? "",
      };
    });
}

async function githubResolveThread(_ctx, threadId) {
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
  let page = 1;
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
      return unresolved + pageUnresolved;
    }
    if (!rt.pageInfo?.hasNextPage) return unresolved;
    after = rt.pageInfo.endCursor ?? null;
  }
  return unresolved;
}
