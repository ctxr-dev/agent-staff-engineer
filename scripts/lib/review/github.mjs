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

/** @returns {object} a ReviewProvider impl bound to gh CLI */
export function makeGithubReviewProvider() {
  return {
    requestReview: githubRequestReview,
    pollForReview: githubPollForReview,
    fetchUnresolvedThreads: githubFetchUnresolvedThreads,
    resolveThread: githubResolveThread,
    ciStateOnHead: githubCiStateOnHead,
  };
}

async function githubRequestReview(ctx) {
  const prNodeId = ctx.prNodeId ?? (await resolvePrNodeId(ctx));
  const botIds = ctx.botIds ?? [];
  if (botIds.length === 0) {
    throw new Error(
      "github review: ctx.botIds is empty; capture the bot node ID (see rules/pr-iteration.md) before calling requestReview",
    );
  }
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
  const { owner, repo, prNumber, headSha } = ctx;
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) { nodes { isResolved } }
          reviews(last: 10) {
            nodes { commit { oid } author { login } }
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
  const state =
    pr.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? "PENDING";
  const reviewOnHead = pr.reviews.nodes.some(
    (r) => r.commit?.oid === headSha,
  );
  return { ciState: state, unresolvedCount, reviewOnHead };
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
  const { ciState } = await githubPollForReview(ctx);
  return ciState;
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
