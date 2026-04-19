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
  const prNodeId = ctx.prNodeId ?? (await resolvePrNodeId(ctx));
  // botIds is inlined into the query text because `gh api graphql -F` does
  // not have clean ergonomics for array values. Each id is JSON-encoded so
  // quoting is correct and prevents any stray shell/GraphQL metacharacter
  // from escaping the string context. The prNodeId goes via a typed var.
  const botIdsList = botIds.map((id) => JSON.stringify(String(id))).join(", ");
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
          reviewThreads(first: 100) { nodes { isResolved } }
          reviews(last: 10) {
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
  const threads = pr.reviewThreads.nodes;
  const unresolvedCount = threads.filter((t) => !t.isResolved).length;
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
  const reviewOnHead = pr.reviews.nodes.some((r) => {
    if ((r.commit?.oid ?? null) !== prHeadSha) return false;
    const author = r.author || {};
    if (Array.isArray(botLogins) && botLogins.length > 0) {
      return typeof author.login === "string" && botLogins.includes(author.login);
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

async function githubFetchUnresolvedThreads(ctx) {
  const { owner, repo, prNumber } = ctx;
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id isResolved isOutdated path line
              comments(first: 5) {
                nodes { author { login } body commit { oid } createdAt }
              }
            }
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
  const threads = data.repository.pullRequest.reviewThreads.nodes;
  return threads
    .filter((t) => !t.isResolved)
    .map((t) => {
      const firstComment = t.comments.nodes[0] ?? {};
      return {
        id: t.id,
        path: t.path,
        line: t.line,
        commitSha: firstComment.commit?.oid ?? null,
        authorLogin: firstComment.author?.login ?? null,
        body: firstComment.body ?? "",
      };
    });
}

async function githubResolveThread(_ctx, threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
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
