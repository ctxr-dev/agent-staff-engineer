// lib/trackers/github.mjs
// GitHub implementation of the Tracker contract. Two namespaces
// are fully implemented:
//   - review.*  against the `requestReviews`, `reviewThreads`,
//     `resolveReviewThread`, `statusCheckRollup` GraphQL mutations
//     captured in skills/pr-iteration/runbook.md (backs skills/pr-iteration).
//   - issues.*  six methods (create, update-status, comment, relabel,
//     get, list) backing every bundle skill that consumes
//     tracker-sync.issues.* at runtime (dev-loop, regression-handler,
//     adapt-system, release-tracker's downstream flows).
// The remaining two namespaces, projects.* and labels.*, are stubbed
// and throw NotSupportedError; PR 10 wires them onto this file.
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
  // issues.* methods need access to the tracker's construction-time
  // target (owner/repo defaults, projects[0] for status mapping).
  // Wrap the module-level implementations as closures that capture
  // `target`, rather than relying on `this` binding, so destructured
  // callers (`const {comment} = tracker.issues`) keep working.
  const issues = {
    createIssue: (ctx, payload) => githubCreateIssue(target, ctx, payload),
    updateIssueStatus: (ctx, payload) => githubUpdateIssueStatus(target, ctx, payload),
    comment: (ctx, payload) => githubComment(target, ctx, payload),
    relabelIssue: (ctx, payload) => githubRelabelIssue(target, ctx, payload),
    getIssue: (ctx, payload) => githubGetIssue(target, ctx, payload),
    listIssues: (ctx, payload) => githubListIssues(target, ctx, payload),
  };
  // Construction-time coverage assert: if REVIEW_METHODS (or the
  // issues list in TRACKER_NAMESPACES) grows a new entry and this
  // file forgets to wire it, fail loudly here rather than letting
  // the skill hit a bare `x is not a function` at runtime.
  const missingReview = REVIEW_METHODS.filter((m) => typeof review[m] !== "function");
  if (missingReview.length > 0) {
    throw new Error(
      `makeGithubTracker: missing review methods [${missingReview.join(", ")}]; wire them or update REVIEW_METHODS`,
    );
  }
  const missingIssues = TRACKER_NAMESPACES.issues.filter((m) => typeof issues[m] !== "function");
  if (missingIssues.length > 0) {
    throw new Error(
      `makeGithubTracker: missing issues methods [${missingIssues.join(", ")}]; wire them or update TRACKER_NAMESPACES.issues`,
    );
  }
  return {
    kind: "github",
    target,
    review,
    issues,
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

// ============================================================================
// issues.* namespace (PR 9)
//
// Each method takes the common `ctx = { owner, repo }` runtime fields
// (falling back to the tracker's constructor-time `target.owner` / `target.repo`
// when `ctx` omits them) plus a method-specific payload object. The
// implementations make one or more `gh api graphql` calls via
// ghGraphqlQuery / ghGraphqlMutation from ghExec.mjs, matching the
// `review` namespace's transport. Rationale-per-method in the JSDoc blocks
// below. See `skills/tracker-sync/SKILL.md` for the skill-level contract.
// ============================================================================

// Shared utilities -----------------------------------------------------------

/**
 * Pull `owner` + `repo` out of ctx, falling back to the tracker target
 * this provider was constructed with. Throws if neither source has both
 * fields, since every `issues.*` method needs them.
 */
function resolveRepoCoords(ctx, trackerTarget) {
  // Explicit-invalid detection: a caller who passes
  //   ctx.owner = ""  or  ctx.owner = "   "
  // is almost always expressing a bug in their own code, not asking
  // for the tracker default. Raise here so the failure surfaces at
  // the call site. The `||` shortcut would silently fall through to
  // target.owner and send the mutation somewhere the caller didn't
  // intend. Whitespace-only values are treated the same as empty:
  // trim before the length check.
  const validString = (v) => typeof v === "string" && v.trim().length > 0;
  const assertIfPresent = (key, v) => {
    if (v === undefined || v === null) return; // permit fallthrough
    if (!validString(v)) {
      throw new TypeError(
        `github issues: ctx.${key} must be a non-empty string when supplied; got ${JSON.stringify(v)}`,
      );
    }
  };
  assertIfPresent("owner", ctx?.owner);
  assertIfPresent("repo", ctx?.repo);
  // Nullish-coalesce so ctx.owner/repo wins when set (already
  // validated above), else the target's value wins. Only when
  // both are absent does the final check below throw.
  const rawOwner = ctx?.owner ?? trackerTarget?.owner;
  const rawRepo = ctx?.repo ?? trackerTarget?.repo;
  if (!validString(rawOwner)) {
    throw new TypeError("github issues: ctx.owner (or target.owner) is required");
  }
  if (!validString(rawRepo)) {
    throw new TypeError("github issues: ctx.repo (or target.repo) is required");
  }
  // Trim so downstream query text and URL construction sees the
  // canonical value. ops.config.json-derived targets are usually
  // already trimmed by bootstrap, but a caller-supplied ctx may
  // carry accidental padding.
  return { owner: rawOwner.trim(), repo: rawRepo.trim() };
}

/** Validate an integer issue number at the input boundary. */
function requirePositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`github issues: ${label} must be a positive integer; got ${JSON.stringify(value)}`);
  }
}

/**
 * Fetch an issue's GraphQL node id AND its full current label set.
 * Used by every mutation-shaped method (comment, relabel,
 * update-status) that needs the node id; the paginated label fetch
 * additionally backs `relabelIssue`'s delta computation (skipping
 * labels the issue already has) so callers don't get a no-op
 * mutation or, worse, re-add an existing label.
 *
 * Labels are paginated at GitHub's 100-per-page max with a hard
 * cap of 20 pages (= 2000 labels per issue). An issue beyond that
 * is pathological and throws rather than silently truncating.
 *
 * Returns `null` when the issue doesn't exist on a repo that does
 * exist (caller decides whether that's an error). Throws with a
 * pointed error when the repo itself is missing / inaccessible —
 * distinguishes that case from "issue not found" so callers don't
 * misdiagnose auth / targeting problems.
 *
 * Name note: this helper returns more than just the id (id + full
 * label list + title/state/number). Kept as `fetchIssueNodeId` for
 * git-blame continuity across this PR's review iterations; a
 * follow-up rename to `fetchIssueWithLabels` is cheap to do once
 * this PR merges and no more Copilot rounds depend on the symbol
 * name.
 */
async function fetchIssueNodeId(owner, repo, issueNumber) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $labelsAfter: String) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          id number title state
          labels(first: 100, after: $labelsAfter) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const MAX_LABEL_PAGES = 20;
  let labelsAfter = null;
  let page = 0;
  let issueShape = null;
  const allLabelNodes = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    page += 1;
    if (page > MAX_LABEL_PAGES) {
      throw new Error(
        `github issues.fetchIssueNodeId: issue #${issueNumber} has more than ${MAX_LABEL_PAGES * 100} labels; refusing to paginate further`,
      );
    }
    const data = await ghGraphqlQuery(query, {
      owner,
      name: repo,
      number: issueNumber,
      labelsAfter,
    });
    // Distinguish "repo absent / inaccessible" from "issue absent
    // on an existing repo". GraphQL returns repository=null for
    // the first case (no errors block) and that used to surface
    // downstream as the misleading "issue not found" message.
    if (!data?.repository) {
      throw new Error(
        `github issues.fetchIssueNodeId: repository ${owner}/${repo} not found or inaccessible`,
      );
    }
    const issue = data.repository.issue ?? null;
    if (!issue) return null;
    issueShape = issueShape ?? { id: issue.id, number: issue.number, title: issue.title, state: issue.state };
    allLabelNodes.push(...(issue.labels?.nodes ?? []));
    if (!issue.labels?.pageInfo?.hasNextPage) break;
    labelsAfter = issue.labels.pageInfo.endCursor;
  }
  return { ...issueShape, labels: { nodes: allLabelNodes } };
}

/**
 * Resolve an array of label names to their GraphQL node IDs within a
 * given repo. Returns a Map of name -> id for the labels that exist;
 * any unknown label name is collected into `missing[]` for the caller
 * to surface. Pagination is bounded by GitHub's 100-labels-per-page
 * limit; repos with >100 labels walk through a `labels(first:100, after:...)`
 * page loop here rather than silently truncating.
 */
async function resolveLabelIds(owner, repo, names) {
  const wanted = new Set(names);
  const found = new Map();
  let after = null;
  const query = `
    query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        labels(first: 100, after: $after) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const MAX_PAGES = 20;
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(
        `github issues.resolveLabelIds: repo ${owner}/${repo} has more than ${MAX_PAGES * 100} labels; refusing to paginate further`,
      );
    }
    const data = await ghGraphqlQuery(query, { owner, name: repo, after });
    // repository can be null when the repo doesn't exist or the
    // caller lacks access; a bare `data.repository.labels` would
    // then throw an unrelated TypeError. Throw a pointed error so
    // the caller sees the real failure.
    if (!data?.repository) {
      throw new Error(
        `github issues.resolveLabelIds: repository ${owner}/${repo} not found or permission denied`,
      );
    }
    const labels = data.repository.labels;
    for (const l of labels.nodes) {
      if (wanted.has(l.name)) found.set(l.name, l.id);
      if (found.size === wanted.size) break;
    }
    if (found.size === wanted.size) break;
    if (!labels.pageInfo?.hasNextPage) break;
    after = labels.pageInfo.endCursor;
  }
  const missing = names.filter((n) => !found.has(n));
  return { found, missing };
}

// issues.comment -------------------------------------------------------------

async function githubComment(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget);
  const { issueNumber, body } = payload ?? {};
  requirePositiveInt(issueNumber, "issueNumber");
  if (typeof body !== "string" || body.length === 0) {
    throw new TypeError("github issues.comment: body must be a non-empty string");
  }
  const issue = await fetchIssueNodeId(owner, repo, issueNumber);
  if (!issue) {
    throw new Error(`github issues.comment: issue #${issueNumber} not found in ${owner}/${repo}`);
  }
  const mutation = `
    mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }
  `;
  return ghGraphqlMutation(mutation, { subjectId: issue.id, body });
}

// issues.getIssue ------------------------------------------------------------

async function githubGetIssue(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget);
  const { issueNumber } = payload ?? {};
  requirePositiveInt(issueNumber, "issueNumber");
  // Fetch labels + assignees at GitHub's max page size (100) and
  // guard truncation explicitly. Matching listIssues' fail-loud
  // contract: a caller filtering by label or assignee list on a
  // silently-truncated result gets wrong answers, which is worse
  // than a surfaced error. If real projects ever hit 100+ labels
  // or assignees per issue, we add pagination here as a focused
  // follow-up rather than hiding the issue.
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          id number title body state url createdAt closedAt
          author { login }
          assignees(first: 100) {
            nodes { login }
            pageInfo { hasNextPage }
          }
          labels(first: 100) {
            nodes { name }
            pageInfo { hasNextPage }
          }
          milestone { number title state }
        }
      }
    }
  `;
  const data = await ghGraphqlQuery(query, { owner, name: repo, number: issueNumber });
  // Distinguish repo-missing / inaccessible from issue-missing:
  // GraphQL returns repository=null (no errors) when the repo is
  // absent or the caller lacks read access; collapsing that into
  // "issue not found" misdirects debugging.
  if (!data?.repository) {
    throw new Error(
      `github issues.getIssue: repository ${owner}/${repo} not found or inaccessible`,
    );
  }
  const issue = data.repository.issue;
  if (!issue) {
    throw new Error(`github issues.getIssue: issue #${issueNumber} not found in ${owner}/${repo}`);
  }
  if (issue.labels?.pageInfo?.hasNextPage) {
    throw new Error(
      `github issues.getIssue: issue #${issueNumber} has more than 100 labels; refusing to return a truncated label list`,
    );
  }
  if (issue.assignees?.pageInfo?.hasNextPage) {
    throw new Error(
      `github issues.getIssue: issue #${issueNumber} has more than 100 assignees; refusing to return a truncated assignee list`,
    );
  }
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state, // OPEN | CLOSED
    url: issue.url,
    author: issue.author?.login ?? null,
    createdAt: issue.createdAt,
    closedAt: issue.closedAt,
    assignees: issue.assignees.nodes.map((a) => a.login),
    labels: issue.labels.nodes.map((l) => l.name),
    milestone: issue.milestone
      ? { number: issue.milestone.number, title: issue.milestone.title, state: issue.milestone.state }
      : null,
  };
}

// issues.listIssues ----------------------------------------------------------

/**
 * Paginated issue list. Filters:
 *   - state: "OPEN" | "CLOSED" | "ALL" (default: OPEN). Mapped to
 *     GitHub's `issues(states: ...)` arg; "ALL" omits the filter.
 *   - labels: string[]. Client-side filter after the page fetch
 *     (GitHub's Issue.labels arg supports only exact-match on a
 *     single label, and `issues(labels:)` is unavailable on the
 *     Repository connection via GraphQL).
 *   - milestone: { number: int } | null — client-side filter.
 *   - limit: int (default 100; hard max 1000 to match the review
 *     namespace's pagination cap).
 */
async function githubListIssues(trackerTarget, ctx, payload = {}) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget);
  const { state = "OPEN", labels = null, milestone = null, limit = 100 } = payload;
  if (state !== "OPEN" && state !== "CLOSED" && state !== "ALL") {
    throw new TypeError(`github issues.listIssues: state must be "OPEN", "CLOSED", or "ALL"; got ${JSON.stringify(state)}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError(`github issues.listIssues: limit must be a positive integer`);
  }
  // Validate `labels` shape at the boundary. Non-array values used
  // to be silently ignored (Array.isArray guard below); now throw
  // so a caller passing a wrong type (string, object) sees the bug
  // immediately instead of getting unfiltered results. Empty array
  // is allowed and treated as "no label filter".
  if (labels !== null && labels !== undefined) {
    if (!Array.isArray(labels)) {
      throw new TypeError(
        `github issues.listIssues: labels must be an array of non-empty strings when provided; got ${typeof labels}`,
      );
    }
    for (const l of labels) {
      if (typeof l !== "string" || l.trim().length === 0) {
        throw new TypeError(
          `github issues.listIssues: every labels[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
        );
      }
    }
  }
  // Validate `milestone`. `null`/`undefined` means "no filter";
  // otherwise it must be an object with a positive-integer `number`.
  // The prior `typeof milestone.number === "number"` guard let
  // NaN / Infinity through, which quietly filtered out everything.
  if (milestone !== null && milestone !== undefined) {
    if (typeof milestone !== "object" || Array.isArray(milestone)) {
      throw new TypeError(
        `github issues.listIssues: milestone must be null or an object with a positive integer 'number'; got ${typeof milestone}`,
      );
    }
    if (!Number.isInteger(milestone.number) || milestone.number <= 0) {
      throw new TypeError(
        `github issues.listIssues: milestone.number must be a positive integer; got ${JSON.stringify(milestone.number)}`,
      );
    }
  }
  const HARD_CAP = 1000;
  const effectiveLimit = Math.min(limit, HARD_CAP);
  const statesArg = state === "ALL" ? "" : `, states: [${state}]`;
  const query = `
    query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        issues(first: 100, after: $after${statesArg}, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            id number title state url createdAt
            labels(first: 100) {
              nodes { name }
              pageInfo { hasNextPage }
            }
            milestone { number }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const out = [];
  let after = null;
  const MAX_PAGES = 10;
  let page = 0;
  while (out.length < effectiveLimit) {
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(
        `github issues.listIssues: exceeded ${MAX_PAGES} pages for ${owner}/${repo}; tighten filters or raise the cap`,
      );
    }
    const data = await ghGraphqlQuery(query, { owner, name: repo, after });
    const conn = data?.repository?.issues;
    if (!conn) {
      // repository null when repo doesn't exist or caller lacks
      // access. Throw a pointed error rather than the generic
      // TypeError the .issues dereference would otherwise raise.
      throw new Error(
        `github issues.listIssues: repository ${owner}/${repo} not found or inaccessible`,
      );
    }
    for (const n of conn.nodes) {
      // Guard against label truncation: we fetch the first 100
      // labels per issue (GitHub's max page size). An issue with
      // >100 labels would silently omit the overflow, causing
      // label-filter false negatives and incomplete `labels` in
      // the result. Fail loud rather than lie about the data.
      if (n.labels?.pageInfo?.hasNextPage) {
        throw new Error(
          `github issues.listIssues: issue #${n.number} has more than 100 labels; refusing to return a truncated label list`,
        );
      }
      // Client-side filters. Label filter means "has every name in the
      // filter array"; milestone means "same milestone number".
      const nodeLabels = new Set(n.labels.nodes.map((l) => l.name));
      if (Array.isArray(labels) && labels.length > 0) {
        if (!labels.every((l) => nodeLabels.has(l))) continue;
      }
      if (milestone && typeof milestone.number === "number") {
        if (!n.milestone || n.milestone.number !== milestone.number) continue;
      }
      out.push({
        id: n.id,
        number: n.number,
        title: n.title,
        state: n.state,
        url: n.url,
        createdAt: n.createdAt,
        labels: [...nodeLabels],
        milestoneNumber: n.milestone?.number ?? null,
      });
      if (out.length >= effectiveLimit) break;
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// issues.relabelIssue --------------------------------------------------------

/**
 * Add / remove labels on an existing issue. Either or both of `add`
 * and `remove` may be supplied; empty arrays are allowed but result
 * in no mutation call for that side. Unknown label names (not present
 * on the repo) throw with a pointed message listing which ones
 * missed, rather than silently succeeding.
 */
async function githubRelabelIssue(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget);
  const { issueNumber, add: rawAdd = [], remove: rawRemove = [] } = payload ?? {};
  requirePositiveInt(issueNumber, "issueNumber");
  if (!Array.isArray(rawAdd) || !Array.isArray(rawRemove)) {
    throw new TypeError("github issues.relabelIssue: add and remove must be arrays of label names");
  }
  // Dedupe within each side. Duplicates in the caller array would
  // produce duplicate label IDs in the GraphQL mutation input, which
  // GitHub accepts but is redundant work at best; at worst a future
  // API change could make it an error.
  const add = [...new Set(rawAdd)];
  const remove = [...new Set(rawRemove)];
  // Reject a name appearing in BOTH add and remove: the caller's
  // intent is contradictory. Silently resolving in one direction
  // would mask a bug in the caller's plan; fail loud instead.
  const overlap = add.filter((n) => remove.includes(n));
  if (overlap.length > 0) {
    throw new Error(
      `github issues.relabelIssue: labels ${overlap.map((n) => `'${n}'`).join(", ")} are in both add and remove; caller intent is ambiguous`,
    );
  }
  if (add.length === 0 && remove.length === 0) {
    // Nothing to do. Match the idempotency contract: no-op is a
    // successful return, not an error.
    return { added: [], removed: [], issueNumber };
  }
  const issue = await fetchIssueNodeId(owner, repo, issueNumber);
  if (!issue) {
    throw new Error(`github issues.relabelIssue: issue #${issueNumber} not found in ${owner}/${repo}`);
  }
  const allNames = [...new Set([...add, ...remove])];
  const { found, missing } = await resolveLabelIds(owner, repo, allNames);
  if (missing.length > 0) {
    throw new Error(
      `github issues.relabelIssue: labels not found in ${owner}/${repo}: ${missing.map((m) => `'${m}'`).join(", ")}`,
    );
  }
  // Filter add/remove down to labels the issue isn't already / is
  // still in, so the result is a true delta (avoids a needless
  // mutation on a re-run). Using the issue's current labels from
  // fetchIssueNodeId.
  const currentSet = new Set(issue.labels.nodes.map((l) => l.name));
  const toAdd = add.filter((n) => !currentSet.has(n));
  const toRemove = remove.filter((n) => currentSet.has(n));
  if (toAdd.length > 0) {
    const ids = toAdd.map((n) => JSON.stringify(found.get(n))).join(", ");
    const mutation = `
      mutation($labelableId: ID!) {
        addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: [${ids}] }) {
          labelable { ... on Issue { id } }
        }
      }
    `;
    await ghGraphqlMutation(mutation, { labelableId: issue.id });
  }
  if (toRemove.length > 0) {
    const ids = toRemove.map((n) => JSON.stringify(found.get(n))).join(", ");
    const mutation = `
      mutation($labelableId: ID!) {
        removeLabelsFromLabelable(input: { labelableId: $labelableId, labelIds: [${ids}] }) {
          labelable { ... on Issue { id } }
        }
      }
    `;
    await ghGraphqlMutation(mutation, { labelableId: issue.id });
  }
  return { added: toAdd, removed: toRemove, issueNumber };
}

// issues.createIssue ---------------------------------------------------------

/**
 * Create an issue with dedupe-by-title. Required fields: `title`. Optional:
 *   - body: issue body (markdown).
 *   - labels: array of existing label names. Resolved to IDs after
 *     creation (GitHub's createIssue input only accepts label IDs,
 *     not names, so we apply labels via addLabelsToLabelable in a
 *     second mutation).
 *   - templateName: caller-chosen template identifier, opaque to
 *     this method. When set, the caller's `body` is ignored and
 *     `ctx.templateLoader(templateName, ctx.templateVars ?? {})`
 *     is invoked to produce the rendered body. Template rendering
 *     lives at the caller so the tracker stays filesystem-pure.
 *
 * NOT supported on this namespace yet (PR 9 scope): `milestone`
 * (needs a milestone-by-number resolve step before bind) and
 * `assignees` (needs a users-by-login resolve step). Both were
 * removed from the payload to avoid the "accepted but silently
 * dropped" footgun. PR 10 reviews the broader reconcile surface
 * that will land both in one go.
 *
 * Dedupe: before creating, the method lists open issues by the
 * requested title (exact match). If one already exists, it is
 * returned as-is without a create. This matches the skill-level
 * idempotency contract documented in skills/tracker-sync/SKILL.md.
 */
async function githubCreateIssue(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget);
  const {
    title,
    body = "",
    labels = [],
    templateName = null,
  } = payload ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TypeError("github issues.createIssue: title must be a non-empty string");
  }
  if (!Array.isArray(labels)) {
    throw new TypeError("github issues.createIssue: labels must be an array of label names");
  }
  // Catch callers still passing the old fields: silent drop would
  // produce an issue without the requested assignee / milestone and
  // leave the caller wondering why the bind didn't happen.
  if (payload && ("milestone" in payload || "assignees" in payload)) {
    throw new Error(
      "github issues.createIssue: 'milestone' and 'assignees' are not supported on this namespace yet; apply them via a follow-up mutation (PR 10 will add the reconcile surface)",
    );
  }
  // Dedupe: search open issues by exact title. GitHub's search is
  // ranked + substring-based, so an exact match may not appear on
  // the first page of results even when there are only a handful
  // of issues with related titles. Paginate through up to
  // DEDUPE_MAX_RESULTS before giving up; if no match is found
  // within that window, create anyway (better to accept a tiny
  // residual duplicate risk than to burn unbounded search quota).
  const dedupeQuery = `
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 100, after: $after) {
        nodes { ... on Issue { id number title state repository { nameWithOwner } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const q = `is:issue is:open repo:${owner}/${repo} in:title "${title.replace(/"/g, '\\"')}"`;
  const DEDUPE_MAX_RESULTS = 500;
  let dedupeScanned = 0;
  let dedupeAfter = null;
  let match = null;
  while (dedupeScanned < DEDUPE_MAX_RESULTS) {
    const dupeData = await ghGraphqlQuery(dedupeQuery, { q, after: dedupeAfter });
    const nodes = dupeData?.search?.nodes || [];
    match = nodes.find(
      (n) => n && n.title === title && n.repository?.nameWithOwner === `${owner}/${repo}`,
    );
    if (match) break;
    dedupeScanned += nodes.length;
    const pageInfo = dupeData?.search?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || nodes.length === 0) break;
    dedupeAfter = pageInfo.endCursor;
  }
  if (match) {
    return { id: match.id, number: match.number, existed: true };
  }
  // Render body from template when requested. The caller injects the
  // loader (keeps the tracker filesystem-pure for tests + parallel
  // platforms). Template vars come from ctx.templateVars.
  let finalBody = body;
  if (templateName) {
    if (typeof ctx?.templateLoader !== "function") {
      throw new TypeError(
        "github issues.createIssue: templateName was supplied but ctx.templateLoader is not a function",
      );
    }
    finalBody = await ctx.templateLoader(templateName, ctx.templateVars ?? {});
    if (typeof finalBody !== "string") {
      throw new TypeError(
        "github issues.createIssue: ctx.templateLoader must return a string (rendered body)",
      );
    }
  }
  // Resolve the repository node ID for createIssue's input.
  const repoQuery = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }
  `;
  const repoData = await ghGraphqlQuery(repoQuery, { owner, name: repo });
  const repoId = repoData?.repository?.id;
  if (!repoId) {
    throw new Error(`github issues.createIssue: repository ${owner}/${repo} not found`);
  }
  // createIssue mutation. Labels are applied in a separate step below
  // because the mutation's labelIds input wants node IDs, not names,
  // and we want the caller to pass names.
  const createMutation = `
    mutation($repoId: ID!, $title: String!, $body: String!) {
      createIssue(input: { repositoryId: $repoId, title: $title, body: $body }) {
        issue { id number url }
      }
    }
  `;
  const createData = await ghGraphqlMutation(createMutation, { repoId, title, body: finalBody });
  const created = createData?.createIssue?.issue;
  if (!created?.id) {
    throw new Error("github issues.createIssue: createIssue response missing issue.id");
  }
  // Apply labels best-effort. The issue was already created above,
  // so a label-apply failure (missing label name, permission error,
  // transient transport failure) must NOT lose the created issue's
  // metadata. Catch and surface the failure on the return value so
  // the caller sees both the success of the create AND the label
  // failure, and can retry or manually patch labels without
  // re-creating the issue.
  let labelError = null;
  if (labels.length > 0) {
    try {
      await githubRelabelIssue({ owner, repo }, { owner, repo }, {
        issueNumber: created.number,
        add: labels,
      });
    } catch (e) {
      labelError = e;
    }
  }
  // Assignees + milestone: left as future work; the payload guard
  // above refuses to accept those keys today. Tests lock on the
  // create + labels path for PR 9; PR 10's labels.* + projects.*
  // namespaces will revisit the broader reconcile semantics that
  // cover assignee resolution (which needs a users(first) query).
  const result = { id: created.id, number: created.number, url: created.url, existed: false };
  if (labelError) result.labelError = labelError;
  return result;
}

// issues.updateIssueStatus ---------------------------------------------------

/**
 * Move an issue's status on its bound Project v2. Refuses to set
 * Done (the human-gate contract in rules/pr-workflow.md). No-op
 * when the item is already in the requested status.
 *
 * `status` is one of the agent's vocabulary keys
 * (backlog / ready / in_progress / in_review / done). Mapped to the
 * Project v2 option name via `trackerTarget.projects[0].status_values`.
 * Config must supply a dev project binding for this method to work;
 * throws otherwise.
 */
async function githubUpdateIssueStatus(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget);
  const { issueNumber, status } = payload ?? {};
  requirePositiveInt(issueNumber, "issueNumber");
  if (typeof status !== "string" || status.length === 0) {
    throw new TypeError("github issues.updateIssueStatus: status must be a non-empty string key");
  }
  // Refuse Done per the human-gate contract.
  if (status === "done") {
    throw new Error(
      "github issues.updateIssueStatus: refusing to set status 'done'; that is a human gate (see rules/pr-workflow.md)",
    );
  }
  const target = trackerTarget;
  const project = target?.projects?.[0];
  if (!project || typeof project.number !== "number") {
    throw new Error(
      "github issues.updateIssueStatus: tracker target has no projects[0] binding; cannot resolve Project v2 item",
    );
  }
  const nativeStatusName = project.status_values?.[status];
  if (typeof nativeStatusName !== "string" || nativeStatusName.length === 0) {
    throw new Error(
      `github issues.updateIssueStatus: status '${status}' has no native mapping in projects[0].status_values`,
    );
  }
  // statusField: default to "Status" only when project.status_field
  // is nullish (undefined / null), treating that as an absent
  // value. A present-but-empty / non-string value is a schema
  // violation that the runtime should surface, not silently coerce
  // to the default — the earlier `|| "Status"` form would mask
  // misconfigurations like `status_field: ""`, `status_field: 0`,
  // or `status_field: false` and then update the wrong field.
  const rawStatusField = project.status_field;
  if (rawStatusField !== undefined && rawStatusField !== null) {
    if (typeof rawStatusField !== "string" || rawStatusField.trim().length === 0) {
      throw new Error(
        `github issues.updateIssueStatus: projects[0].status_field must be a non-empty string when provided; got ${JSON.stringify(rawStatusField)}`,
      );
    }
  }
  const statusField = rawStatusField ?? "Status";
  // statusField flows through an ops.config.json string that the
  // user (or adapt-system) supplies. Validate it as a simple field
  // identifier (letters, digits, space, underscore, dash) before
  // it touches the query text. This closes a GraphQL-injection /
  // query-corruption footgun: a name with `"` or newlines would
  // otherwise break the query silently. GitHub field names in the
  // wild are all short human-readable strings, so a conservative
  // allow-list catches every legitimate case.
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(statusField)) {
    throw new Error(
      `github issues.updateIssueStatus: unsafe status_field '${statusField}'; expected letters/digits/space/_/-`,
    );
  }
  const projectNumber = project.number;
  const projectOwner = project.owner || owner;
  // Compound query: resolve issue's project item, the project's
  // Status field node id, the option id for the target name, and
  // the current value — all in one round trip. The `statusField`
  // is interpolated inline because GitHub's GraphQL `fieldValueByName`
  // and `field` args accept string literals only (no variable of
  // type String is allowed there); the `${statusField}` value is
  // gated by the regex above so that this is safe.
  const quotedField = JSON.stringify(statusField); // double-quoted, escaped
  // First: resolve the Project v2 field + options ONCE. These do
  // not depend on the issue's projectItems, so hoisting them out
  // of the projectItems loop keeps the query small per page.
  const fieldQuery = `
    query($projectOwner: String!, $projectNumber: Int!) {
      repositoryOwner(login: $projectOwner) {
        ... on ProjectV2Owner {
          projectV2(number: $projectNumber) {
            id
            field(name: ${quotedField}) {
              ... on ProjectV2SingleSelectField { id options { id name } }
            }
          }
        }
      }
    }
  `;
  const fieldData = await ghGraphqlQuery(fieldQuery, { projectOwner, projectNumber });
  const projectV2 = fieldData?.repositoryOwner?.projectV2;
  if (!projectV2?.id) {
    throw new Error(
      `github issues.updateIssueStatus: Project v2 #${projectNumber} not found under ${projectOwner}`,
    );
  }
  const field = projectV2.field;
  if (!field?.id) {
    throw new Error(
      `github issues.updateIssueStatus: field '${statusField}' not found on Project v2 #${projectNumber}`,
    );
  }
  const option = field.options.find((o) => o.name === nativeStatusName);
  if (!option) {
    throw new Error(
      `github issues.updateIssueStatus: option '${nativeStatusName}' (mapped from '${status}') not found on field '${statusField}'`,
    );
  }
  // Second: paginate the issue's projectItems to find the one
  // bound to our project. An issue linked to >20 projects would
  // previously miss the target on the first-page-only fetch. Match
  // on projectV2.id (owner-scoped number collisions possible).
  const itemsQuery = `
    query($owner: String!, $name: String!, $issueNumber: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        issue(number: $issueNumber) {
          id
          projectItems(first: 100, after: $after) {
            nodes {
              id
              project { id number }
              fieldValueByName(name: ${quotedField}) {
                ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const MAX_PROJECT_ITEM_PAGES = 10;
  let after = null;
  let page = 0;
  let projectItem = null;
  let issueFound = false;
  while (!projectItem) {
    page += 1;
    if (page > MAX_PROJECT_ITEM_PAGES) {
      throw new Error(
        `github issues.updateIssueStatus: issue #${issueNumber} is linked to more than ${MAX_PROJECT_ITEM_PAGES * 100} projects; refusing to paginate further`,
      );
    }
    const data = await ghGraphqlQuery(itemsQuery, {
      owner,
      name: repo,
      issueNumber,
      after,
    });
    const issue = data?.repository?.issue;
    if (!issue) {
      throw new Error(`github issues.updateIssueStatus: issue #${issueNumber} not found in ${owner}/${repo}`);
    }
    issueFound = true;
    projectItem = issue.projectItems.nodes.find(
      (n) => n && n.project?.id === projectV2.id,
    );
    if (projectItem) break;
    if (!issue.projectItems.pageInfo?.hasNextPage) break;
    after = issue.projectItems.pageInfo.endCursor;
  }
  if (!issueFound) {
    // Unreachable under the happy path (the loop always sets
    // issueFound on its first iteration or throws). Defence in
    // depth against a future refactor that changes control flow.
    /* istanbul ignore next */
    throw new Error(`github issues.updateIssueStatus: issue #${issueNumber} not found in ${owner}/${repo}`);
  }
  if (!projectItem?.id) {
    throw new Error(
      `github issues.updateIssueStatus: issue #${issueNumber} is not bound to Project v2 #${projectNumber}; add it to the project first`,
    );
  }
  // Idempotency: no-op when the item is already in the target status.
  const currentValue = projectItem.fieldValueByName;
  if (currentValue && currentValue.optionId === option.id) {
    return { issueNumber, status, changed: false, optionId: option.id };
  }
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `;
  await ghGraphqlMutation(mutation, {
    projectId: projectV2.id,
    itemId: projectItem.id,
    fieldId: field.id,
    optionId: option.id,
  });
  return { issueNumber, status, changed: true, optionId: option.id };
}
