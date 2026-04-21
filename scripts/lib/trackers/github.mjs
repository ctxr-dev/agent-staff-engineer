// lib/trackers/github.mjs
// GitHub implementation of the Tracker contract. All four
// namespaces on the Tracker surface are fully implemented:
//   - review.*  against the `requestReviews`, `reviewThreads`,
//     `resolveReviewThread`, `statusCheckRollup` GraphQL mutations
//     captured in skills/pr-iteration/runbook.md (backs skills/pr-iteration).
//   - issues.*  six methods (create, update-status, comment, relabel,
//     get, list) backing every bundle skill that consumes
//     tracker-sync.issues.* at runtime (dev-loop, regression-handler,
//     adapt-system, release-tracker's downstream flows).
//   - labels.*  reconcileLabels + relabelBulk, backing
//     adapt-system's label-taxonomy reconciles and bulk renames.
//   - projects.*  reconcileProjectFields, listProjectItems,
//     updateProjectField on GitHub Projects v2, backing
//     release-tracker's umbrella field writes and any caller that
//     needs custom Project v2 field reads / writes.
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
  // labels and projects namespaces follow the same closure-over-target
  // pattern as issues. Destructured callers (`const {reconcileLabels}
  // = tracker.labels`) keep working.
  const labels = {
    reconcileLabels: (ctx, payload) => githubReconcileLabels(target, ctx, payload),
    relabelBulk: (ctx, payload) => githubRelabelBulk(target, ctx, payload),
  };
  const projects = {
    listProjectItems: (ctx, payload) => githubListProjectItems(target, ctx, payload),
    updateProjectField: (ctx, payload) => githubUpdateProjectField(target, ctx, payload),
    reconcileProjectFields: (ctx, payload) => githubReconcileProjectFields(target, ctx, payload),
  };
  // Construction-time coverage assert: if REVIEW_METHODS (or the
  // issues / labels / projects lists in TRACKER_NAMESPACES) grows a
  // new entry and this file forgets to wire it, fail loudly here
  // rather than letting the skill hit a bare `x is not a function`
  // at runtime.
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
  const missingLabels = TRACKER_NAMESPACES.labels.filter((m) => typeof labels[m] !== "function");
  if (missingLabels.length > 0) {
    throw new Error(
      `makeGithubTracker: missing labels methods [${missingLabels.join(", ")}]; wire them or update TRACKER_NAMESPACES.labels`,
    );
  }
  const missingProjects = TRACKER_NAMESPACES.projects.filter((m) => typeof projects[m] !== "function");
  if (missingProjects.length > 0) {
    throw new Error(
      `makeGithubTracker: missing projects methods [${missingProjects.join(", ")}]; wire them or update TRACKER_NAMESPACES.projects`,
    );
  }
  return {
    kind: "github",
    target,
    review,
    issues,
    labels,
    projects,
  };
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
// GitHub owner/repo name regexes. Owner is 1-39 chars, must start
// AND end with an alphanumeric, and may contain SINGLE hyphens
// between alphanumerics (no consecutive `--`, no leading or trailing
// `-`). That mirrors GitHub's published username/org-name rules.
// Repo is 1-100 chars, alphanumeric + `-` + `_` + `.` (observed +
// docs; the server has additional rules we don't reproduce).
// These are stricter than "any non-empty string" and close the
// Windows shell-injection surface (ghExec currently uses
// `shell: true` on some platforms); no legitimate caller ever needs
// a character outside the allow-list. The length cap is enforced
// by a lookahead so the structural rule and the length rule stay
// in one expression.
const GITHUB_OWNER_RE = /^(?=.{1,39}$)[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;
const GITHUB_REPO_RE  = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Resolve owner + repo for namespaces that need both (issues.*,
 * labels.*). The optional `prefix` parameter (default "github
 * issues") names the caller surface in every validation error so
 * labels.* callers see "github labels.reconcileLabels: ..." rather
 * than misleading "github issues: ..." prefixes. Existing
 * issues.* call sites rely on the default.
 */
function resolveRepoCoords(ctx, trackerTarget, prefix = "github issues") {
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
        `${prefix}: ctx.${key} must be a non-empty string when supplied; got ${JSON.stringify(v)}`,
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
    throw new TypeError(`${prefix}: ctx.owner (or target.owner) is required`);
  }
  if (!validString(rawRepo)) {
    throw new TypeError(`${prefix}: ctx.repo (or target.repo) is required`);
  }
  // Trim first, then validate against GitHub's name constraints.
  // This both canonicalises whitespace-padded config and closes
  // the shell-injection surface on platforms where ghExec uses
  // shell: true (Windows). An unusable repo name would have
  // failed at the GraphQL layer anyway; reject here with a
  // clearer error and no side effects.
  const owner = rawOwner.trim();
  const repo = rawRepo.trim();
  if (!GITHUB_OWNER_RE.test(owner)) {
    throw new TypeError(
      `${prefix}: owner must match GitHub's owner-name rules (1-39 chars, alphanumeric + hyphens); got ${JSON.stringify(owner)}`,
    );
  }
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new TypeError(
      `${prefix}: repo must match GitHub's repo-name rules (1-100 chars, alphanumeric + '.' + '-' + '_'); got ${JSON.stringify(repo)}`,
    );
  }
  return { owner, repo };
}

/**
 * Validate an integer id/number at the input boundary.
 * `prefix` names the caller surface in the error (eg
 * "github issues.getIssue", "github projects.listProjectItems").
 * Defaults to "github issues" for backwards compatibility with
 * existing call sites.
 */
function requirePositiveInt(value, label, prefix = "github issues") {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${prefix}: ${label} must be a positive integer; got ${JSON.stringify(value)}`);
  }
}

/**
 * Resolve an owner login for `projects.*` methods where the caller
 * can name the project explicitly via `payload.projectOwner`.
 * Precedence: `projectOwner` (payload) > `ctxOwner` (context) >
 * `targetOwner` (tracker binding). This lets callers run a
 * project op against a project whose owner differs from the
 * tracker's default owner, without having to forge a ctx.owner.
 * All inputs get the same trim + GITHUB_OWNER_RE canonicalisation.
 */
function resolveProjectOwner({ projectOwner, ctxOwner, targetOwner }, nsLabel) {
  const candidates = [
    ["payload.projectOwner", projectOwner],
    ["ctx.owner", ctxOwner],
    ["target.owner", targetOwner],
  ];
  for (const [src, value] of candidates) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(
        `github ${nsLabel}: ${src} must be a non-empty string when supplied; got ${JSON.stringify(value)}`,
      );
    }
    const owner = value.trim();
    if (!GITHUB_OWNER_RE.test(owner)) {
      throw new TypeError(
        `github ${nsLabel}: ${src} must match GitHub's owner-name rules (1-39 chars, alphanumeric + hyphens); got ${JSON.stringify(owner)}`,
      );
    }
    return owner;
  }
  throw new TypeError(
    `github ${nsLabel}: owner is required; supply payload.projectOwner, ctx.owner, or trackerTarget.owner`,
  );
}

/**
 * Fetch an issue's GraphQL node id AND its full current label set.
 * Currently used by `relabelIssue` only: it needs the node id for
 * the add/remove mutations, and the paginated label fetch backs
 * the delta computation (skipping labels the issue already has) so
 * callers don't get a no-op mutation or, worse, re-add an existing
 * label. `comment` uses the lighter `fetchIssueIdOnly` helper since
 * it only needs the id; `updateIssueStatus` fetches directly via
 * its own compound project-item query. The "used by comment /
 * update-status" phrasing earlier in PR 9's history was pre-R14;
 * see git-blame if you need the full migration path.
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
 * Lightweight variant: fetch only the issue's GraphQL node ID (plus
 * the id/number/title/state echo) WITHOUT paginating labels. Used
 * by methods that don't need the label set (`comment`). Saves N
 * extra GraphQL calls on heavily-labeled issues.
 *
 * Same repo-null vs issue-null distinction as `fetchIssueNodeId`.
 * Returns `null` when the issue doesn't exist on a real repo;
 * throws on repo-absent / inaccessible.
 */
async function fetchIssueIdOnly(owner, repo, issueNumber) {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) { id number title state }
      }
    }
  `;
  const data = await ghGraphqlQuery(query, { owner, name: repo, number: issueNumber });
  if (!data?.repository) {
    throw new Error(
      `github issues.fetchIssueIdOnly: repository ${owner}/${repo} not found or inaccessible`,
    );
  }
  return data.repository.issue ?? null;
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
        `github issues.resolveLabelIds: repository ${owner}/${repo} not found or inaccessible`,
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
  // Use the lightweight id-only fetch: posting a comment only
  // needs the issue node id, so paginating the full label set
  // (as fetchIssueNodeId does) would burn up to 20 extra
  // GraphQL pages on a heavily-labeled issue for no gain.
  const issue = await fetchIssueIdOnly(owner, repo, issueNumber);
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
 *     GitHub's `issues(states: ...)` arg; "ALL" passes an explicit
 *     `states: [OPEN, CLOSED]` (the connection's server-side default
 *     is [OPEN], so omitting the arg would silently behave as OPEN).
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
    throw new TypeError(`github issues.listIssues: limit must be a positive integer; got ${JSON.stringify(limit)}`);
  }
  // Validate `labels` shape at the boundary. Non-array values used
  // to be silently ignored (Array.isArray guard below); now throw
  // so a caller passing a wrong type (string, object) sees the bug
  // immediately instead of getting unfiltered results. Empty array
  // is allowed and treated as "no label filter".
  // Also normalise to the trimmed value so downstream equality
  // comparisons use the canonical form. A caller-supplied "bug "
  // would otherwise pass validation and then never match "bug"
  // labels on the fetched issues.
  let normalisedLabels = labels;
  if (labels !== null && labels !== undefined) {
    if (!Array.isArray(labels)) {
      throw new TypeError(
        `github issues.listIssues: labels must be an array of non-empty strings when provided; got ${typeof labels}`,
      );
    }
    normalisedLabels = labels.map((l) => {
      if (typeof l !== "string" || l.trim().length === 0) {
        throw new TypeError(
          `github issues.listIssues: every labels[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
        );
      }
      return l.trim();
    });
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
  // Map "ALL" to an explicit both-states list. GitHub's
  // Repository.issues connection defaults to [OPEN], so omitting
  // the arg entirely (our earlier impl) meant "ALL" behaved
  // identically to "OPEN" and never returned closed issues.
  const statesArg = state === "ALL"
    ? ", states: [OPEN, CLOSED]"
    : `, states: [${state}]`;
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
      // Use the trimmed, canonical label array normalised above so
      // whitespace in a caller input doesn't silently miss matches.
      const nodeLabels = new Set(n.labels.nodes.map((l) => l.name));
      if (Array.isArray(normalisedLabels) && normalisedLabels.length > 0) {
        if (!normalisedLabels.every((l) => nodeLabels.has(l))) continue;
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
  // Validate every label-name entry at the boundary so non-string /
  // whitespace-only inputs surface as a clear input error rather
  // than a misleading "labels not found" further down when
  // resolveLabelIds can't match them. Normalise to the trimmed
  // value so downstream dedupe / overlap checks and label lookup
  // operate on the canonical form (a caller's "bug " would
  // otherwise defeat the delta semantics against existing labels).
  const normaliseLabelArray = (arr, key) => arr.map((l) => {
    if (typeof l !== "string" || l.trim().length === 0) {
      throw new TypeError(
        `github issues.relabelIssue: every ${key}[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
      );
    }
    return l.trim();
  });
  const normalisedAdd = normaliseLabelArray(rawAdd, "add");
  const normalisedRemove = normaliseLabelArray(rawRemove, "remove");
  // Dedupe within each side. Duplicates in the caller array would
  // produce duplicate label IDs in the GraphQL mutation input, which
  // GitHub accepts but is redundant work at best; at worst a future
  // API change could make it an error.
  const add = [...new Set(normalisedAdd)];
  const remove = [...new Set(normalisedRemove)];
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
  let {
    title,
    body = "",
    labels = [],
    templateName = null,
  } = payload ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TypeError("github issues.createIssue: title must be a non-empty string");
  }
  // Normalise to the trimmed form so dedupe (n.title === title) and
  // the createIssue mutation both operate on the canonical value.
  // Without this, an input of " my title " would pass validation
  // but then mismatch any existing " my title" dedupe target, and
  // the created issue would carry the leading/trailing whitespace.
  title = title.trim();
  // body is optional; empty string is fine. A non-string value
  // (number, boolean, object) used to flow into the GraphQL mutation
  // via `-F body=<value>`, which gh silently typed as number/boolean
  // and then the server rejected with a generic "expected String"
  // error. Validate here so the caller sees the actual bug.
  if (typeof body !== "string") {
    throw new TypeError(
      `github issues.createIssue: body must be a string when provided; got ${JSON.stringify(body)}`,
    );
  }
  if (!Array.isArray(labels)) {
    throw new TypeError("github issues.createIssue: labels must be an array of label names");
  }
  // Validate each label entry here so the failure points at the
  // createIssue call rather than surfacing later through the
  // relabelIssue delegation with a less-actionable "labels not
  // found" message. Normalise to the trimmed value and reassign
  // labels so the downstream relabelIssue delegation applies the
  // canonical names; otherwise "bug " would pass here and fail
  // there.
  labels = labels.map((l) => {
    if (typeof l !== "string" || l.trim().length === 0) {
      throw new TypeError(
        `github issues.createIssue: every labels[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
      );
    }
    return l.trim();
  });
  // Catch callers still passing the old fields: silent drop would
  // produce an issue without the requested assignee / milestone and
  // leave the caller wondering why the bind didn't happen.
  if (payload && ("milestone" in payload || "assignees" in payload)) {
    throw new Error(
      "github issues.createIssue: 'milestone' and 'assignees' are not supported on this namespace yet; apply them via a follow-up mutation (PR 10 will add the reconcile surface)",
    );
  }
  // Validate templateName here at the input boundary (before any
  // network calls) so a caller bug surfaces immediately without
  // first burning a dedupe search against the gh API. Matches the
  // title/labels/milestone/assignees rejections above.
  if (templateName !== null && templateName !== undefined) {
    if (typeof templateName !== "string" || templateName.trim().length === 0) {
      throw new TypeError(
        `github issues.createIssue: templateName must be a non-empty string when supplied; got ${JSON.stringify(templateName)}`,
      );
    }
    // Also validate ctx.templateLoader here at the input boundary
    // (hoisted from the later "render body" block) so a caller
    // supplying templateName without a loader fails fast — without
    // first burning a dedupe search + repo-id lookup against the
    // gh API. The call-site check is kept downstream as defence
    // in depth but is now unreachable under normal flow.
    if (typeof ctx?.templateLoader !== "function") {
      throw new TypeError(
        "github issues.createIssue: templateName was supplied but ctx.templateLoader is not a function",
      );
    }
    // Normalise to the trimmed value so the downstream
    // ctx.templateLoader call sees the canonical name. A caller's
    // "issue.md " would otherwise pass validation and fail the
    // template lookup with a less-actionable filesystem error.
    templateName = templateName.trim();
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
        nodes { ... on Issue { id number title state url repository { nameWithOwner } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  // Escape before embedding into the GitHub search phrase. Earlier
  // impl only escaped `"`, but a title containing backslashes or
  // control chars can still break the phrase and produce a failed
  // dedupe. Normalise control chars (C0 + DEL) to spaces, escape
  // backslash then quote (order matters), and collapse runs of
  // whitespace so the search still matches the user-visible title
  // up to GitHub's tokeniser. The client-side strict-equality
  // filter (`n.title === title`) stays as the authoritative match.
  // eslint-disable-next-line no-control-regex
  const searchPhrase = String(title)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\s+/g, " ")
    .trim();
  const q = `is:issue is:open repo:${owner}/${repo} in:title "${searchPhrase}"`;
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
    // Return the same shape as the create path: { id, number, url,
    // existed, labelError? }. Callers can read `result.url`
    // unconditionally without branching on `existed`.
    return { id: match.id, number: match.number, url: match.url, existed: true };
  }
  // Render body from template when requested. The caller injects the
  // loader (keeps the tracker filesystem-pure for tests + parallel
  // platforms). Template vars come from ctx.templateVars.
  // (templateName type/shape was validated at the input boundary above.)
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
    throw new Error(`github issues.createIssue: repository ${owner}/${repo} not found or inaccessible`);
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
      // Capture as a plain object so JSON.stringify surfaces the
      // message (Error instances stringify to `{}` otherwise,
      // losing the context a caller needs to retry / debug).
      labelError = {
        name: e?.name ?? "Error",
        message: e?.message ?? String(e),
      };
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
  const { issueNumber, status: rawStatus } = payload ?? {};
  requirePositiveInt(issueNumber, "issueNumber");
  if (typeof rawStatus !== "string" || rawStatus.trim().length === 0) {
    throw new TypeError("github issues.updateIssueStatus: status must be a non-empty string key (whitespace-only rejected)");
  }
  // Trim so whitespace around the key doesn't miss the status_values
  // map (e.g. user typed `"in_progress "` in the config by mistake).
  const status = rawStatus.trim();
  // Refuse Done per the human-gate contract.
  if (status === "done") {
    throw new Error(
      "github issues.updateIssueStatus: refusing to set status 'done'; that is a human gate (see rules/pr-workflow.md)",
    );
  }
  const target = trackerTarget;
  const project = target?.projects?.[0];
  if (!project) {
    throw new Error(
      "github issues.updateIssueStatus: tracker target has no projects[0] binding; cannot resolve Project v2 item",
    );
  }
  // The schema types `project.number` as integer >= 1, but the
  // runtime must also guard against hand-edited configs producing
  // non-integer / NaN / Infinity values that would otherwise fail
  // later in the GraphQL call with a less-actionable error.
  if (!Number.isInteger(project.number) || project.number <= 0) {
    throw new TypeError(
      `github issues.updateIssueStatus: tracker target projects[0].number must be a positive integer; got ${JSON.stringify(project.number)}`,
    );
  }
  const rawNativeStatusName = project.status_values?.[status];
  if (typeof rawNativeStatusName !== "string" || rawNativeStatusName.trim().length === 0) {
    throw new Error(
      `github issues.updateIssueStatus: status '${status}' has no native mapping in projects[0].status_values`,
    );
  }
  // Normalise the mapped option name so the `field.options.find`
  // below sees the canonical form. A config like
  // `status_values: { in_progress: "In progress " }` would pass
  // the schema's minLength check but then fail the option-name
  // equality here with a misleading "option not found".
  const nativeStatusName = rawNativeStatusName.trim();
  // statusField: default to "Status" only when project.status_field
  // is nullish (undefined / null), treating that as an absent
  // value. A present-but-empty / non-string value is a schema
  // violation that the runtime should surface, not silently coerce
  // to the default — the earlier `|| "Status"` form would mask
  // misconfigurations like `status_field: ""`, `status_field: 0`,
  // or `status_field: false` and then update the wrong field.
  const rawStatusField = project.status_field;
  let normalisedStatusField;
  if (rawStatusField !== undefined && rawStatusField !== null) {
    if (typeof rawStatusField !== "string" || rawStatusField.trim().length === 0) {
      throw new Error(
        `github issues.updateIssueStatus: projects[0].status_field must be a non-empty string when provided; got ${JSON.stringify(rawStatusField)}`,
      );
    }
    // Normalise to the trimmed form so the GraphQL query sees the
    // canonical field name. A config with `status_field: "Status "`
    // would otherwise pass validation and then fail with a
    // misleading "field not found".
    normalisedStatusField = rawStatusField.trim();
  }
  const statusField = normalisedStatusField ?? "Status";
  // statusField flows through an ops.config.json string that the
  // user (or adapt-system) supplies, and is interpolated into the
  // GraphQL query as a double-quoted string literal via
  // JSON.stringify below. The quoting is injection-safe for any
  // Unicode string, so the runtime validation only needs to reject
  // genuinely dangerous inputs: control characters (which the
  // GraphQL server rejects as malformed), NUL (which truncates in
  // some transports), and overly long strings (DoS guard). This is
  // the smallest rule that matches the schema's `type: "string"`
  // contract without silently refusing otherwise-valid GitHub
  // Project v2 field names (which can include punctuation, emoji,
  // etc.). A stricter rule would diverge from the schema and make
  // otherwise-valid configs fail at runtime.
  if (typeof statusField !== "string" || statusField.length === 0 || statusField.length > 256) {
    throw new Error(
      `github issues.updateIssueStatus: unsafe status_field (must be 1-256 chars); got length ${statusField?.length}`,
    );
  }
  // Reject NUL and any C0 control character (0x00-0x1F + 0x7F).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(statusField)) {
    throw new Error(
      `github issues.updateIssueStatus: unsafe status_field contains control characters`,
    );
  }
  const projectNumber = project.number;
  // project.owner is optional; when present, validate the same way
  // ctx.owner/repo are validated: non-empty string, trimmed, passes
  // GitHub's owner-name allow-list. Nullish fallthrough uses the
  // parent tracker's owner (already validated by resolveRepoCoords
  // above).
  let projectOwner = owner;
  if (project.owner !== undefined && project.owner !== null) {
    if (typeof project.owner !== "string" || project.owner.trim().length === 0) {
      throw new TypeError(
        `github issues.updateIssueStatus: projects[0].owner must be a non-empty string when provided; got ${JSON.stringify(project.owner)}`,
      );
    }
    const candidate = project.owner.trim();
    if (!GITHUB_OWNER_RE.test(candidate)) {
      throw new TypeError(
        `github issues.updateIssueStatus: projects[0].owner must match GitHub's owner-name rules (1-39 chars, alphanumeric + hyphens); got ${JSON.stringify(project.owner)}`,
      );
    }
    projectOwner = candidate;
  }
  // Multi-step resolve, NOT a single compound round trip: first
  // look up the project's Status field id + options once; then
  // paginate the issue's projectItems to find the one bound to
  // this project (and read its current value); finally fire the
  // update mutation. The split is deliberate (PR 9 R3) because
  // projectItems can have >100 entries and would otherwise force
  // the field-lookup to refetch on every page. The `statusField`
  // is interpolated inline (via JSON.stringify) because GitHub's
  // GraphQL `fieldValueByName` and `field` args accept string
  // literals only (no variable of type String is allowed there);
  // the `${statusField}` value is gated by the validation above
  // so that this is safe.
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
    // Distinguish repo-absent from issue-absent on the items query.
    // Without this, a missing / inaccessible repo would surface as
    // "issue not found", masking the real auth / targeting failure.
    if (!data?.repository) {
      throw new Error(
        `github issues.updateIssueStatus: repository ${owner}/${repo} not found or inaccessible`,
      );
    }
    const issue = data.repository.issue;
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

// ============================================================================
// labels.* namespace (PR 10)
// ============================================================================

/**
 * Normalise a GitHub label color to its canonical lowercase 6-hex
 * form (GitHub accepts `#` prefix but strips it; values are case-
 * insensitive but stored lowercase). Returns `null` if the caller
 * didn't supply one (caller-chosen omission means "don't manage
 * color in the diff").
 */
function normaliseLabelColor(color) {
  if (color === undefined || color === null) return null;
  if (typeof color !== "string") {
    throw new TypeError(
      `github labels: color must be a 6-hex string (with or without '#'); got ${JSON.stringify(color)}`,
    );
  }
  const stripped = color.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(stripped)) {
    throw new TypeError(
      `github labels: color must be a 6-hex string (with or without '#'); got ${JSON.stringify(color)}`,
    );
  }
  return stripped;
}

/**
 * Fetch every label on the repo as `{id, name, color, description}`.
 * Paginated at GitHub's 100-per-page max; hard-capped at 20 pages.
 * Throws on repo-null / inaccessible (same wording as sibling helpers).
 */
async function fetchAllRepoLabels(owner, repo) {
  const query = `
    query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        labels(first: 100, after: $after) {
          nodes { id name color description }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const MAX_PAGES = 20;
  let after = null;
  let page = 0;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(
        `github labels: repo ${owner}/${repo} has more than ${MAX_PAGES * 100} labels; refusing to paginate further`,
      );
    }
    const data = await ghGraphqlQuery(query, { owner, name: repo, after });
    if (!data?.repository) {
      throw new Error(
        `github labels: repository ${owner}/${repo} not found or inaccessible`,
      );
    }
    const conn = data.repository.labels;
    all.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return all;
}

/**
 * Compute a reconcile plan: what labels need to be added, edited, or
 * deprecated so the repo matches the declared taxonomy. Callable
 * without any network by passing the fetched current labels directly.
 * Module-local today (not exported); tests exercise it via the
 * public `reconcileLabels` entry point.
 *
 * @param {Array<{name:string, color?:string, description?:string}>} declared
 *   Desired labels. `name` is the match key; `color` and `description`
 *   are optional (undefined means "don't manage").
 * @param {Array<{id:string, name:string, color:string, description:string|null}>} current
 *   Labels currently on the repo (from fetchAllRepoLabels).
 * @param {{allowDeprecate?: boolean}} [opts]
 *   When `allowDeprecate` is true, every label NOT in `declared` is
 *   added to the `deprecate` bucket. Default false (safe: don't
 *   propose deletions the caller didn't opt into).
 * @returns {{ add: object[], edit: object[], deprecate: object[], unchanged: object[] }}
 */
function computeLabelReconcilePlan(declared, current, opts = {}) {
  const { allowDeprecate = false } = opts;
  const declaredByName = new Map(declared.map((d) => [d.name, d]));
  const currentByName = new Map(current.map((c) => [c.name, c]));
  const add = [];
  const edit = [];
  const deprecate = [];
  const unchanged = [];
  for (const d of declared) {
    const wantedColor = normaliseLabelColor(d.color);
    const wantedDescription = d.description ?? null;
    const existing = currentByName.get(d.name);
    if (!existing) {
      add.push({
        name: d.name,
        color: wantedColor, // may be null; caller defaults it
        description: wantedDescription,
      });
      continue;
    }
    const diffs = [];
    if (wantedColor !== null && existing.color.toLowerCase() !== wantedColor) {
      diffs.push("color");
    }
    if (d.description !== undefined && (existing.description ?? null) !== wantedDescription) {
      diffs.push("description");
    }
    if (diffs.length > 0) {
      edit.push({
        id: existing.id,
        name: existing.name,
        changes: diffs,
        // Only send fields that are actually changing, so the
        // mutation is minimal and a partial-permission failure
        // surfaces narrowly.
        color: diffs.includes("color") ? wantedColor : undefined,
        description: diffs.includes("description") ? wantedDescription : undefined,
      });
    } else {
      unchanged.push({ id: existing.id, name: existing.name });
    }
  }
  if (allowDeprecate) {
    for (const c of current) {
      if (!declaredByName.has(c.name)) {
        deprecate.push({ id: c.id, name: c.name });
      }
    }
  }
  return { add, edit, deprecate, unchanged };
}

/**
 * labels.reconcileLabels: fetch the repo's current labels, diff
 * against the caller-supplied taxonomy, apply the diff.
 *
 * Payload shape:
 *   - `taxonomy`: array of `{name, color?, description?}`. `name` is
 *     the primary key. A missing `color` or `description` means
 *     "don't manage this field on this label"; existing values are
 *     left alone.
 *   - `apply`: default `false` (dry-run). When `false`, returns the
 *     computed plan without any mutations. When `true`, fires
 *     createLabel / updateLabel / deleteLabel for each diff entry.
 *   - `allowDeprecate`: default `false`. When `true`, every repo
 *     label NOT in `taxonomy` is added to the `deprecate` bucket
 *     and (if `apply: true`) deleted. Callers who pass a PARTIAL
 *     taxonomy MUST leave this `false` to avoid mass-deleting
 *     unrelated labels.
 *
 * Idempotent: running twice against the same state produces an
 * empty plan on the second run.
 */
async function githubReconcileLabels(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget, "github labels.reconcileLabels");
  const { taxonomy, apply = false, allowDeprecate = false } = payload ?? {};
  // Strict boolean guards. Passing a truthy non-boolean (eg the
  // string "false" or the number 1) would silently enable writes
  // or the destructive deprecate path. Reject at the boundary.
  if (typeof apply !== "boolean") {
    throw new TypeError(
      `github labels.reconcileLabels: apply must be a boolean; got ${JSON.stringify(apply)}`,
    );
  }
  if (typeof allowDeprecate !== "boolean") {
    throw new TypeError(
      `github labels.reconcileLabels: allowDeprecate must be a boolean; got ${JSON.stringify(allowDeprecate)}`,
    );
  }
  if (!Array.isArray(taxonomy)) {
    throw new TypeError(
      "github labels.reconcileLabels: taxonomy must be an array of {name, color?, description?}",
    );
  }
  // Boundary-validate + canonicalise each taxonomy entry. Trim the
  // name at the boundary and keep the canonical form everywhere
  // downstream (seen-set dedup, computeLabelReconcilePlan, mutation
  // payloads). "bug" and "bug " are the same label; treating them
  // as different would bypass the duplicate check and create a
  // second label on the repo.
  const seen = new Set();
  const normalisedTaxonomy = [];
  for (const entry of taxonomy) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `github labels.reconcileLabels: every taxonomy entry must be a plain object; got ${JSON.stringify(entry)}`,
      );
    }
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      throw new TypeError(
        `github labels.reconcileLabels: entry.name must be a non-empty string; got ${JSON.stringify(entry.name)}`,
      );
    }
    const name = entry.name.trim();
    if (seen.has(name)) {
      throw new Error(
        `github labels.reconcileLabels: duplicate entry name '${name}' in taxonomy`,
      );
    }
    seen.add(name);
    normaliseLabelColor(entry.color); // throws on bad format; return value ignored here
    if (entry.description !== undefined && entry.description !== null && typeof entry.description !== "string") {
      throw new TypeError(
        `github labels.reconcileLabels: entry.description must be a string or null when provided; got ${JSON.stringify(entry.description)}`,
      );
    }
    normalisedTaxonomy.push({ ...entry, name });
  }
  const current = await fetchAllRepoLabels(owner, repo);
  const plan = computeLabelReconcilePlan(normalisedTaxonomy, current, { allowDeprecate });
  if (!apply) {
    return { mode: "dry-run", plan };
  }
  // Resolve repo node id ONCE for createLabel (the mutation wants
  // repositoryId, not owner/name). Existing labels already carry
  // their node ids from fetchAllRepoLabels.
  let repoId = null;
  if (plan.add.length > 0) {
    const data = await ghGraphqlQuery(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      { owner, name: repo },
    );
    repoId = data?.repository?.id;
    if (!repoId) {
      throw new Error(
        `github labels.reconcileLabels: repository ${owner}/${repo} not found or inaccessible`,
      );
    }
  }
  const applied = { added: [], edited: [], deprecated: [] };
  for (const a of plan.add) {
    const color = a.color ?? "ededed"; // GitHub's grey default; caller may have declined to specify
    const descArg = a.description != null ? JSON.stringify(a.description) : "null";
    const mutation = `
      mutation($repoId: ID!, $name: String!, $color: String!) {
        createLabel(input: { repositoryId: $repoId, name: $name, color: $color, description: ${descArg} }) {
          label { id name color }
        }
      }
    `;
    await ghGraphqlMutation(mutation, { repoId, name: a.name, color });
    applied.added.push(a.name);
  }
  for (const e of plan.edit) {
    // Only include fields that are actually changing; GitHub's
    // updateLabel mutation accepts partial updates.
    const parts = [`id: $id`];
    const vars = { id: e.id };
    if (e.color !== undefined) {
      parts.push(`color: $color`);
      vars.color = e.color;
    }
    if (e.description !== undefined) {
      // Description is nullable; inline to preserve null semantics
      // (GraphQL doesn't let a variable carry `null` for a nullable
      // input cleanly without explicit type declaration).
      parts.push(`description: ${e.description === null ? "null" : JSON.stringify(e.description)}`);
    }
    const parameterDecls = ["$id: ID!"];
    if (e.color !== undefined) parameterDecls.push("$color: String!");
    const mutation = `
      mutation(${parameterDecls.join(", ")}) {
        updateLabel(input: { ${parts.join(", ")} }) {
          label { id name color }
        }
      }
    `;
    await ghGraphqlMutation(mutation, vars);
    applied.edited.push({ name: e.name, changes: e.changes });
  }
  for (const d of plan.deprecate) {
    const mutation = `
      mutation($id: ID!) {
        deleteLabel(input: { id: $id }) {
          clientMutationId
        }
      }
    `;
    await ghGraphqlMutation(mutation, { id: d.id });
    applied.deprecated.push(d.name);
  }
  return { mode: "applied", plan, applied };
}

/**
 * labels.relabelBulk: apply a rename plan across open issues. For
 * each `{from, to}` entry, every open issue carrying `from` gets
 * `to` added and `from` removed (in that order; GitHub accepts the
 * pair even on the same issue).
 *
 * Payload:
 *   - `plan`: array of `{from, to}`. Both must be strings.
 *   - `apply`: default `false`. Dry-run returns the list of issues
 *     that WOULD be relabeled, not the mutations.
 *   - `state`: default `"OPEN"`. Filter for which issues to scan
 *     (same semantics as listIssues).
 *
 * Order is preserved per entry; within an entry, issues are
 * relabeled in the order `listIssues` returns them. Delta
 * semantics: if an issue already has `to` and lacks `from`, no-op
 * for that issue + that entry.
 */
async function githubRelabelBulk(trackerTarget, ctx, payload) {
  const { owner, repo } = resolveRepoCoords(ctx, trackerTarget, "github labels.relabelBulk");
  const { plan, apply = false, state = "OPEN" } = payload ?? {};
  if (typeof apply !== "boolean") {
    throw new TypeError(
      `github labels.relabelBulk: apply must be a boolean; got ${JSON.stringify(apply)}`,
    );
  }
  // Validate `state` at this surface: listIssues accepts the same
  // set but raises with an "issues.*" error prefix, which is
  // confusing for a labels.* caller debugging a typo.
  if (state !== "OPEN" && state !== "CLOSED" && state !== "ALL") {
    throw new TypeError(
      `github labels.relabelBulk: state must be one of "OPEN", "CLOSED", or "ALL"; got ${JSON.stringify(state)}`,
    );
  }
  if (!Array.isArray(plan)) {
    throw new TypeError("github labels.relabelBulk: plan must be an array of {from, to}");
  }
  for (const entry of plan) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `github labels.relabelBulk: every plan entry must be a plain object; got ${JSON.stringify(entry)}`,
      );
    }
    if (typeof entry.from !== "string" || entry.from.trim().length === 0) {
      throw new TypeError(
        `github labels.relabelBulk: entry.from must be a non-empty string; got ${JSON.stringify(entry.from)}`,
      );
    }
    if (typeof entry.to !== "string" || entry.to.trim().length === 0) {
      throw new TypeError(
        `github labels.relabelBulk: entry.to must be a non-empty string; got ${JSON.stringify(entry.to)}`,
      );
    }
    if (entry.from.trim() === entry.to.trim()) {
      throw new Error(
        `github labels.relabelBulk: entry.from and entry.to must differ; got '${entry.from}' for both`,
      );
    }
  }
  // Dedicated scanner. Reusing listIssues is wrong here because its
  // label filter is client-side (GitHub's Repository.issues accepts
  // `labels` but listIssues intentionally doesn't pass it through,
  // since it supports multi-label AND semantics that differ from the
  // server-side arg). On a large repo with many open issues but few
  // carrying `from`, listIssues would scan its 10-page cap of raw
  // issues (1000 total) before collecting enough post-filter matches
  // and throw, making bulk relabel unusable even when the match set
  // is small. This scanner pushes the label filter to the server,
  // so every returned node is already a match, and fails loud only
  // when the raw page cap is hit AND the server says more pages
  // exist (i.e. the match set itself may be truncated).
  const BULK_RELABEL_PAGE_SIZE = 100;
  const BULK_RELABEL_MAX_PAGES = 10;
  const states =
    state === "ALL" ? ["OPEN", "CLOSED"] : state === "CLOSED" ? ["CLOSED"] : ["OPEN"];
  // Inline states + labels into the query string: ghGraphqlExec
  // rejects complex-typed variables (arrays / objects), so IssueState
  // lists and label-name lists must be baked into the query text.
  // states[] is fixed-enum-safe; labels uses JSON.stringify to
  // produce a properly-escaped GraphQL string literal per item
  // (defence against quote injection in a label name).
  const statesInline = `[${states.join(", ")}]`;
  async function scanIssuesCarryingLabel(fromLabel) {
    const labelsInline = `[${JSON.stringify(fromLabel)}]`;
    const query = `
      query($owner: String!, $repo: String!, $first: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          issues(first: $first, after: $after, states: ${statesInline}, labels: ${labelsInline}, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { number }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    let after = null;
    let pageCount = 0;
    const matching = [];
    while (pageCount < BULK_RELABEL_MAX_PAGES) {
      const data = await ghGraphqlQuery(query, {
        owner,
        repo,
        first: BULK_RELABEL_PAGE_SIZE,
        after,
      });
      const conn = data?.repository?.issues;
      if (!conn) {
        throw new Error(
          `github labels.relabelBulk: repository ${owner}/${repo} not found or inaccessible`,
        );
      }
      for (const n of (conn.nodes ?? [])) {
        if (n && typeof n.number === "number") matching.push({ number: n.number });
      }
      pageCount += 1;
      if (!conn.pageInfo?.hasNextPage) return { matching, truncated: false };
      after = conn.pageInfo.endCursor ?? null;
    }
    return { matching, truncated: true };
  }
  const results = [];
  for (const entry of plan) {
    const from = entry.from.trim();
    const to = entry.to.trim();
    const { matching, truncated } = await scanIssuesCarryingLabel(from);
    if (truncated) {
      throw new Error(
        `github labels.relabelBulk: scanning ${owner}/${repo} for issues carrying '${from}' reached the ${BULK_RELABEL_PAGE_SIZE * BULK_RELABEL_MAX_PAGES}-issue cap (${BULK_RELABEL_MAX_PAGES} pages) with more pages still available; refusing to bulk relabel because the match set may be truncated. Narrow the rename (e.g. apply per-area or close stale issues first) or raise the cap explicitly.`,
      );
    }
    const entryResult = { from, to, issues: matching.map((m) => m.number), changed: [] };
    if (apply && matching.length > 0) {
      for (const iss of matching) {
        try {
          const delta = await githubRelabelIssue(trackerTarget, ctx, {
            issueNumber: iss.number,
            add: [to],
            remove: [from],
          });
          // Only record as changed when the delta actually mutated
          // labels. relabelIssue returns {added: [], removed: []}
          // when the issue already had `to` and lacked `from`
          // (listIssues' label filter can drift between our query
          // and the per-issue mutation).
          const mutated =
            (delta?.added?.length ?? 0) > 0 || (delta?.removed?.length ?? 0) > 0;
          if (mutated) {
            entryResult.changed.push(iss.number);
          }
        } catch (e) {
          // Don't let one issue's failure halt the bulk; surface on
          // the result so the caller can retry the failures. Error
          // shape mirrors createIssue's labelError (plain object).
          entryResult.failures = entryResult.failures ?? [];
          entryResult.failures.push({
            issueNumber: iss.number,
            error: { name: e?.name ?? "Error", message: e?.message ?? String(e) },
          });
        }
      }
    }
    results.push(entryResult);
  }
  return { mode: apply ? "applied" : "dry-run", results };
}

// ============================================================================
// projects.* namespace (PR 10)
// ============================================================================

/**
 * Resolve a Project v2 board's node id from (owner, number). The
 * owner is a login name (User or Organization); Projects v2 uses
 * the repositoryOwner.projectV2 field on either kind.
 *
 * Throws with a pointed error on owner-not-found / project-not-found;
 * the caller doesn't need to distinguish (both result in "cannot
 * proceed").
 */
async function resolveProjectNodeId(owner, projectNumber) {
  const query = `
    query($owner: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        ... on ProjectV2Owner {
          projectV2(number: $number) {
            id
            title
            fields(first: 100) {
              nodes {
                ... on ProjectV2FieldCommon { id name dataType }
                ... on ProjectV2SingleSelectField {
                  options { id name }
                }
              }
              pageInfo { hasNextPage }
            }
          }
        }
      }
    }
  `;
  const data = await ghGraphqlQuery(query, { owner, number: projectNumber });
  const p = data?.repositoryOwner?.projectV2;
  if (!p?.id) {
    throw new Error(
      `github projects: Project v2 #${projectNumber} not found under owner '${owner}'`,
    );
  }
  if (p.fields?.pageInfo?.hasNextPage) {
    // Fields > 100 on one project is rare but possible; fail loud
    // rather than silently omit.
    throw new Error(
      `github projects: Project v2 #${projectNumber} has more than 100 custom fields; pagination not implemented`,
    );
  }
  return { id: p.id, title: p.title, fields: p.fields?.nodes ?? [] };
}

/**
 * projects.listProjectItems: paginated read-only snapshot of
 * ProjectV2 items and their field values.
 *
 * Payload:
 *   - `projectNumber`: integer; required.
 *   - `projectOwner`: optional; defaults to trackerTarget.owner.
 *   - `first`: page size (max 100; default 100).
 *   - `after`: cursor for the next page (null for first page).
 *   - `limit`: cross-page cap (default 500; hard max 2000).
 *
 * Returns `{items: [{id, type, content, fieldValues}], hasNextPage, endCursor}`.
 * `content` is the linked Issue / PR / DraftIssue summary; fieldValues
 * is a map of `fieldName -> value` for the item. Values are
 * normalised per field type: text / number / date fields return
 * scalar strings / numbers / ISO dates; richer field types return
 * structured objects — single-select `{name, optionId}`, iteration
 * `{title, startDate, duration}`. Callers that want a flat scalar
 * form should project each value via its field's known type.
 *
 * `hasNextPage` reflects the server's pageInfo: true when more
 * items exist on the board past the ones we returned. `endCursor`
 * follows GraphQL convention — it is the cursor of the LAST
 * returned item, which a caller passes back as `after` to fetch
 * the next page. The pagination loop caps per-request `first` to
 * the remaining budget, so when `limit` truncates the window the
 * server never returned any item we didn't keep; `endCursor`
 * therefore always matches the last item in `items[]`.
 */
async function githubListProjectItems(trackerTarget, ctx, payload) {
  const { projectNumber, projectOwner, first = 100, after: rawAfter = null, limit = 500 } = payload ?? {};
  requirePositiveInt(projectNumber, "projectNumber", "github projects.listProjectItems");
  // Validate `after` at the boundary: must be null/undefined or a
  // non-empty string. Letting a number or object flow into the
  // GraphQL $after variable produces a less actionable error
  // straight from the server.
  let after;
  if (rawAfter === null || rawAfter === undefined) {
    after = null;
  } else if (typeof rawAfter !== "string" || rawAfter.trim().length === 0) {
    throw new TypeError(
      `github projects.listProjectItems: after must be null or a non-empty string cursor; got ${JSON.stringify(rawAfter)}`,
    );
  } else {
    after = rawAfter.trim();
  }
  if (!Number.isInteger(first) || first <= 0 || first > 100) {
    throw new TypeError(
      `github projects.listProjectItems: first must be an integer 1-100; got ${JSON.stringify(first)}`,
    );
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError(
      `github projects.listProjectItems: limit must be a positive integer; got ${JSON.stringify(limit)}`,
    );
  }
  // Owner resolution, aligned with the payload contract:
  // `payload.projectOwner` wins when set (a caller may name the
  // project explicitly without a repo binding), else
  // `ctx.owner`, else `trackerTarget.owner`. This lets
  // listProjectItems run with only projectOwner supplied by the
  // caller — the previous ordering required ctx.owner or
  // target.owner even when projectOwner was set.
  const ownerLogin = resolveProjectOwner(
    { projectOwner, ctxOwner: ctx?.owner, targetOwner: trackerTarget?.owner },
    "projects.listProjectItems",
  );
  const HARD_CAP = 2000;
  const effectiveLimit = Math.min(limit, HARD_CAP);
  const query = `
    query($owner: String!, $number: Int!, $first: Int!, $after: String) {
      repositoryOwner(login: $owner) {
        ... on ProjectV2Owner {
          projectV2(number: $number) {
            items(first: $first, after: $after) {
              nodes {
                id
                type
                content {
                  __typename
                  ... on Issue { number title url state }
                  ... on PullRequest { number title url state }
                  ... on DraftIssue { title }
                }
                fieldValues(first: 50) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue { field { ... on ProjectV2FieldCommon { name } } text }
                    ... on ProjectV2ItemFieldNumberValue { field { ... on ProjectV2FieldCommon { name } } number }
                    ... on ProjectV2ItemFieldDateValue { field { ... on ProjectV2FieldCommon { name } } date }
                    ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { name } } name optionId }
                    ... on ProjectV2ItemFieldIterationValue { field { ... on ProjectV2FieldCommon { name } } title startDate duration }
                  }
                  pageInfo { hasNextPage }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  `;
  const out = [];
  let cursor = after;
  // Derive the page cap from `effectiveLimit / first` so a caller
  // passing `first: 10, limit: 500` doesn't trip at item 200. Keep
  // a floor of 20 as a safety buffer: GitHub's Projects v2 API can
  // legally return fewer than `first` items per page (eg when field
  // values are cached differently), so the best-case math alone
  // would reject a request that would actually succeed. An
  // independent hard ceiling of 100 prevents pathological input
  // (`first: 1, limit: 2000` → up to 2000 requests) from burning
  // gh rate-limit budget. A caller who genuinely needs more items
  // with a low `first` splits the fetch into resumable calls via
  // `after`.
  const HARD_PAGE_CAP = 100;
  const MAX_PAGES = Math.min(HARD_PAGE_CAP, Math.max(20, Math.ceil(effectiveLimit / first)));
  let page = 0;
  let finalCursor = null;
  let finalHasNext = false;
  while (out.length < effectiveLimit) {
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(
        `github projects.listProjectItems: exceeded ${MAX_PAGES} pages for project #${projectNumber}; raise the cap or tighten the query`,
      );
    }
    // Cap per-request `first` to the remaining budget so the server
    // never returns more items than we'll consume. Without this, a
    // mid-page truncation (eg `first: 100, limit: 150` — 100 on page
    // 1, then 50 out of 100 on page 2) returns `pageInfo.endCursor`
    // for the *last server-returned node* (position 100 on page 2),
    // not the last node the caller keeps (position 50). A caller
    // resuming with `after: endCursor` would then miss 50 items.
    const remaining = effectiveLimit - out.length;
    const perPage = Math.min(first, remaining);
    const data = await ghGraphqlQuery(query, { owner: ownerLogin, number: projectNumber, first: perPage, after: cursor });
    const project = data?.repositoryOwner?.projectV2;
    if (!project) {
      throw new Error(
        `github projects.listProjectItems: Project v2 #${projectNumber} not found under owner '${ownerLogin}'`,
      );
    }
    const conn = project.items;
    // `conn.nodes` can legally be null in GraphQL connections when
    // the server returns a partial response; coalesce to an empty
    // array so the loop below doesn't throw on iteration.
    for (const n of (conn?.nodes ?? [])) {
      if (n.fieldValues?.pageInfo?.hasNextPage) {
        throw new Error(
          `github projects.listProjectItems: item ${n.id} has more than 50 field values; refusing to return truncated data`,
        );
      }
      // Null-prototype object so server-controlled field names
      // (which a motivated admin could set to "__proto__" or
      // "constructor") cannot walk into Object.prototype and
      // pollute the runtime. The caller gets a plain data bag
      // they can iterate with for..in safely.
      const fieldMap = Object.create(null);
      for (const fv of (n.fieldValues?.nodes ?? [])) {
        const fname = fv.field?.name;
        if (!fname) continue;
        if ("text" in fv) fieldMap[fname] = fv.text;
        else if ("number" in fv) fieldMap[fname] = fv.number;
        else if ("date" in fv) fieldMap[fname] = fv.date;
        else if ("optionId" in fv) fieldMap[fname] = { name: fv.name, optionId: fv.optionId };
        else if ("startDate" in fv) fieldMap[fname] = { title: fv.title, startDate: fv.startDate, duration: fv.duration };
      }
      out.push({
        id: n.id,
        type: n.type,
        content: n.content,
        fieldValues: fieldMap,
      });
      // No mid-page `break` needed: `perPage` is already capped at
      // `remaining`, so the server returns at most `remaining`
      // items. If it returns fewer, fine — we loop again.
    }
    finalHasNext = Boolean(conn?.pageInfo?.hasNextPage);
    finalCursor = conn?.pageInfo?.endCursor ?? null;
    if (!finalHasNext) break;
    cursor = finalCursor;
  }
  // `hasNextPage` reflects the server's pageInfo only. `finalCursor`
  // is the cursor of the last returned item (standard GraphQL
  // convention) — callers pass it back as `after` to resume from
  // the next item. The pagination loop above caps per-request
  // `first` to the remaining budget, so the server never returned
  // any item we skipped; suppressing `hasNextPage` when `limit`
  // truncated would hide the fact that more items exist on the
  // board past the window we returned.
  return { items: out, hasNextPage: finalHasNext, endCursor: finalCursor };
}

/**
 * projects.updateProjectField: write a single field value on a
 * single item. Refuses to write to a field the project doesn't
 * declare (via trackerTarget.projects[].fields), because silently
 * creating fields would drift the schema the team agreed on.
 *
 * Payload:
 *   - `projectNumber`: required.
 *   - `projectOwner`: optional; defaults to trackerTarget.owner.
 *   - `itemId`: ProjectV2Item node ID; required.
 *   - `field`: field name (not ID); required. Must appear in the
 *     trackerTarget's `projects[i].fields` array for this project
 *     number.
 *   - `value`: one of:
 *     - `{ text: "..." }` for text fields
 *     - `{ number: 42 }` for number fields
 *     - `{ date: "2026-04-20" }` for date fields
 *     - `{ singleSelect: "<option name>" }` for single-select
 *       fields (the method resolves the option id from the
 *       project's field definition).
 *   - `apply`: default `false` (dry-run returns the mutation args
 *     without firing).
 *
 * Refuses to clear a field (null value) in this PR; dedicated
 * `clearProjectField` helper is a follow-up.
 */
async function githubUpdateProjectField(trackerTarget, ctx, payload) {
  const { projectNumber, projectOwner, itemId, field, value, apply = false } = payload ?? {};
  if (typeof apply !== "boolean") {
    throw new TypeError(
      `github projects.updateProjectField: apply must be a boolean; got ${JSON.stringify(apply)}`,
    );
  }
  requirePositiveInt(projectNumber, "projectNumber", "github projects.updateProjectField");
  if (typeof itemId !== "string" || itemId.trim().length === 0) {
    throw new TypeError(
      `github projects.updateProjectField: itemId must be a non-empty string; got ${JSON.stringify(itemId)}`,
    );
  }
  const canonicalItemId = itemId.trim();
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new TypeError(
      `github projects.updateProjectField: field must be a non-empty string; got ${JSON.stringify(field)}`,
    );
  }
  const canonicalField = field.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "github projects.updateProjectField: value must be a plain object with one of {text, number, date, singleSelect}",
    );
  }
  // Owner resolution aligned with the payload contract (see
  // listProjectItems / reconcileProjectFields): payload.projectOwner
  // > ctx.owner > trackerTarget.owner.
  const ownerLogin = resolveProjectOwner(
    { projectOwner, ctxOwner: ctx?.owner, targetOwner: trackerTarget?.owner },
    "projects.updateProjectField",
  );
  // Normalise the configured `p.owner` before comparing. A config
  // that accidentally ships "acme " (trailing whitespace) would
  // otherwise never match the already-trimmed `ownerLogin` and
  // block writes with a misleading "not declared" error. The
  // schema (githubProjectV2.required) mandates `owner` on every
  // declared project entry, so there is no fallback path: a
  // declared entry missing its own `owner` is a schema violation
  // and fails to match here, surfacing as "not declared" rather
  // than silently inheriting.
  const normaliseDeclaredOwner = (configuredOwner) => {
    if (typeof configuredOwner !== "string") return null;
    const t = configuredOwner.trim();
    if (t.length === 0 || !GITHUB_OWNER_RE.test(t)) return null;
    return t;
  };
  const declared = (trackerTarget?.projects ?? []).find(
    (p) => p?.number === projectNumber && normaliseDeclaredOwner(p?.owner) === ownerLogin,
  );
  if (!declared) {
    throw new Error(
      `github projects.updateProjectField: Project v2 #${projectNumber} under '${ownerLogin}' is not declared in trackers.projects[]; refusing to write`,
    );
  }
  const declaredFields = Array.isArray(declared.fields) ? declared.fields : [];
  // Status is always implicitly managed via updateIssueStatus; allow
  // it without requiring it in `fields`. Any OTHER field must be in
  // `fields`. Compare on the canonicalised (trimmed) field name so
  // " Status " and "Status" match the declared entry. Trim
  // `declared.status_field` too: a config with `"Status "` must
  // still recognise writes to "Status" as implicit.
  const canonicalStatusField =
    typeof declared.status_field === "string" && declared.status_field.trim().length > 0
      ? declared.status_field.trim()
      : "Status";
  const implicitFields = new Set([canonicalStatusField]);
  const declaredFieldsSet = new Set(
    declaredFields.map((n) => (typeof n === "string" ? n.trim() : n)),
  );
  if (!implicitFields.has(canonicalField) && !declaredFieldsSet.has(canonicalField)) {
    throw new Error(
      `github projects.updateProjectField: field '${canonicalField}' is not declared in trackers.projects[#${projectNumber}].fields (declared: ${declaredFields.join(", ") || "<none>"})`,
    );
  }
  // Validate the value shape at the boundary — BEFORE any network call.
  // The single-select option resolution still needs the project lookup
  // (we don't know the option IDs until we fetch the project), but
  // shape checks (one-of, right type per kind) can short-circuit
  // here so a caller bug doesn't burn a gh call.
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new TypeError(
      `github projects.updateProjectField: value must have exactly one of {text, number, date, singleSelect}; got keys [${keys.join(", ")}]`,
    );
  }
  const [kind] = keys;
  // Canonicalised value holders — never mutate the caller's
  // `value` object: callers commonly reuse the payload for logging,
  // retries, and diffing, and silent mutation (eg trimming
  // singleSelect) would surprise them.
  let singleSelectName = null;
  if (kind === "text") {
    if (typeof value.text !== "string") {
      throw new TypeError("github projects.updateProjectField: value.text must be a string");
    }
  } else if (kind === "number") {
    if (!Number.isFinite(value.number)) {
      throw new TypeError("github projects.updateProjectField: value.number must be a finite number");
    }
  } else if (kind === "date") {
    if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
      throw new TypeError("github projects.updateProjectField: value.date must be an ISO date (YYYY-MM-DD)");
    }
  } else if (kind === "singleSelect") {
    if (typeof value.singleSelect !== "string" || value.singleSelect.trim().length === 0) {
      throw new TypeError("github projects.updateProjectField: value.singleSelect must be a non-empty string (option name)");
    }
    // Canonicalise so " P0 " and "P0" both resolve against the
    // project's option list. Local variable, not input mutation.
    singleSelectName = value.singleSelect.trim();
  } else {
    throw new TypeError(
      `github projects.updateProjectField: unknown value kind '${kind}'; expected text / number / date / singleSelect`,
    );
  }
  // Resolve the project + field + (if single-select) option IDs.
  const { id: projectId, fields: fieldNodes } = await resolveProjectNodeId(ownerLogin, projectNumber);
  const fieldNode = fieldNodes.find((f) => f && f.name === canonicalField);
  if (!fieldNode?.id) {
    throw new Error(
      `github projects.updateProjectField: field '${canonicalField}' not found on Project v2 #${projectNumber}`,
    );
  }
  // Guard against writing the wrong value kind to the wrong field
  // shape. GitHub would reject the mutation with a GraphQL error,
  // but doing the check locally avoids burning a call and produces
  // a more pointed message. `dataType` comes from ProjectV2FieldCommon
  // on `resolveProjectNodeId`; ITERATION fields don't yet round-trip
  // through this method so they fall through to the "no matching
  // kind" branch.
  const kindToDataType = {
    text: "TEXT",
    number: "NUMBER",
    date: "DATE",
    singleSelect: "SINGLE_SELECT",
  };
  const expectedDataType = kindToDataType[kind];
  if (fieldNode.dataType && expectedDataType && fieldNode.dataType !== expectedDataType) {
    throw new TypeError(
      `github projects.updateProjectField: field '${canonicalField}' has dataType ${fieldNode.dataType}, but value kind '${kind}' expects dataType ${expectedDataType}`,
    );
  }
  // Build the value expression based on which key is set.
  let valueInput;
  if (kind === "text") {
    valueInput = `{ text: ${JSON.stringify(value.text)} }`;
  } else if (kind === "number") {
    valueInput = `{ number: ${value.number} }`;
  } else if (kind === "date") {
    valueInput = `{ date: ${JSON.stringify(value.date)} }`;
  } else if (kind === "singleSelect") {
    const options = fieldNode.options ?? [];
    const opt = options.find((o) => o && o.name === singleSelectName);
    if (!opt?.id) {
      const avail = options.map((o) => o.name).join(", ") || "<none>";
      throw new Error(
        `github projects.updateProjectField: option '${singleSelectName}' not found on field '${canonicalField}' (available: ${avail})`,
      );
    }
    valueInput = `{ singleSelectOptionId: ${JSON.stringify(opt.id)} }`;
  } else {
    /* istanbul ignore next — kind was already validated above */
    throw new TypeError(
      `github projects.updateProjectField: unknown value kind '${kind}'; expected text / number / date / singleSelect`,
    );
  }
  const mutationArgs = { projectId, itemId: canonicalItemId, fieldId: fieldNode.id, field: canonicalField, kind };
  if (!apply) {
    return { mode: "dry-run", mutationArgs };
  }
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: ${valueInput}
      }) {
        projectV2Item { id }
      }
    }
  `;
  await ghGraphqlMutation(mutation, { projectId, itemId: canonicalItemId, fieldId: fieldNode.id });
  return { mode: "applied", mutationArgs };
}

/**
 * projects.reconcileProjectFields: ensure every field named in the
 * caller-supplied `payload.declared` list (typically derived from
 * `ops.config.json -> trackers.projects[].fields`) exists on the
 * Project v2 board identified by `payload.projectNumber`
 * (optionally scoped to `payload.projectOwner`). Entries are
 * trimmed and deduplicated at the input boundary. Missing fields
 * are added via `createProjectV2Field`; no edits, no deletes
 * (deletions are a destructive op users do via the UI).
 *
 * The `dataType` for newly-created fields defaults to TEXT (the
 * only type that doesn't require extra config). Callers needing
 * SINGLE_SELECT / DATE / NUMBER / ITERATION declare the field in
 * the UI first; this method never invents option lists.
 */
async function githubReconcileProjectFields(trackerTarget, ctx, payload) {
  const { projectNumber, projectOwner, declared, apply = false } = payload ?? {};
  if (typeof apply !== "boolean") {
    throw new TypeError(
      `github projects.reconcileProjectFields: apply must be a boolean; got ${JSON.stringify(apply)}`,
    );
  }
  requirePositiveInt(projectNumber, "projectNumber", "github projects.reconcileProjectFields");
  if (!Array.isArray(declared)) {
    throw new TypeError(
      "github projects.reconcileProjectFields: declared must be an array of field names (strings)",
    );
  }
  // Trim + dedupe at the boundary. "Priority" and "Priority " are the
  // same field; counting them as distinct would treat the trailing
  // space as "missing" on the board and try to re-create it. First
  // occurrence wins so callers still get a deterministic `missing` /
  // `present` order.
  const seen = new Set();
  const normalisedDeclared = [];
  for (const n of declared) {
    if (typeof n !== "string" || n.trim().length === 0) {
      throw new TypeError(
        `github projects.reconcileProjectFields: declared[] entries must be non-empty strings; got ${JSON.stringify(n)}`,
      );
    }
    const canonical = n.trim();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    normalisedDeclared.push(canonical);
  }
  // Owner resolution aligned with the payload contract (see
  // listProjectItems): payload.projectOwner > ctx.owner >
  // trackerTarget.owner. A caller can name the project with only
  // projectOwner, no ctx binding required.
  const ownerLogin = resolveProjectOwner(
    { projectOwner, ctxOwner: ctx?.owner, targetOwner: trackerTarget?.owner },
    "projects.reconcileProjectFields",
  );
  const { id: projectId, fields: existingFields } = await resolveProjectNodeId(ownerLogin, projectNumber);
  const existingNames = new Set(existingFields.map((f) => f?.name).filter(Boolean));
  const missing = normalisedDeclared.filter((n) => !existingNames.has(n));
  const present = normalisedDeclared.filter((n) => existingNames.has(n));
  if (!apply) {
    return { mode: "dry-run", projectNumber, missing, present };
  }
  const created = [];
  for (const name of missing) {
    const mutation = `
      mutation($projectId: ID!, $name: String!) {
        createProjectV2Field(input: {
          projectId: $projectId
          name: $name
          dataType: TEXT
        }) {
          projectV2Field { ... on ProjectV2FieldCommon { id name } }
        }
      }
    `;
    await ghGraphqlMutation(mutation, { projectId, name });
    created.push(name);
  }
  return { mode: "applied", projectNumber, missing, present, created };
}
