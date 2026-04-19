// lib/trackers/tracker.mjs
// The `Tracker` interface: a duck-typed contract every concrete tracker
// backend implements. A Tracker covers everything a skill might want to
// do against an issue-tracking / project-management / code-review host:
// issues CRUD, labels, project v2 fields, status moves, comments,
// PR / MR / change creation and review iteration.
//
// The pr-iteration skill drives the post-push loop through
// `tracker.review.*`, which is the review-iteration subset (request an
// external reviewer, poll for CI + review, fetch unresolved threads,
// triage, resolve). Keeping the review methods as a namespace inside
// Tracker rather than a separate ReviewProvider keeps the dispatcher
// story clean: there is exactly one way to pick a tracker from
// `ops.config.json`, and every method on it is either implemented or
// surfaces `NotSupportedError`.
//
// Concrete implementations:
//   - github.mjs   — full impl backed by the `gh` CLI + GraphQL
//   - jira.mjs     — stub; throws NotSupportedError on every method
//   - linear.mjs   — stub
//   - gitlab.mjs   — stub
//
// The dispatcher (dispatcher.mjs) picks a Tracker from
// `ops.config.json -> trackers.{dev,release}` based on the required
// `kind` discriminator. There is no legacy fallback: a config without
// a `trackers:` block is a config error, surfaced at schema-validation
// time.

/**
 * Thrown by Tracker implementations that don't support a given
 * operation on the current tracker kind. Carries `kind` and `op` for
 * useful diagnostics at the skill level.
 *
 * @param {string} message
 * @param {{kind?: string, op?: string, namespace?: string}} [info]
 *   kind: tracker kind ("jira", "linear", "gitlab", ...)
 *   op: operation name ("createIssue", "review.requestReview", ...)
 *   namespace: sub-namespace ("review", "issues", "projects") if any
 */
export class NotSupportedError extends Error {
  constructor(message, { kind = null, op = null, namespace = null } = {}) {
    super(message);
    this.name = "NotSupportedError";
    this.kind = kind;
    this.op = op;
    this.namespace = namespace;
  }
}

/**
 * Names of the review-subset methods every Tracker exposes under
 * `tracker.review.*`. Exported so tests can assert method coverage
 * without hardcoding the list, and so stub factories can iterate.
 *
 * Semantics (see scripts/lib/trackers/github.mjs for the canonical
 * reference implementation):
 *   requestReview(ctx)           -> register external reviewer on HEAD
 *   pollForReview(ctx)           -> one-shot probe; returns
 *       { ciState: "SUCCESS"|"FAILURE"|"ERROR"|"PENDING",
 *         unresolvedCount: number, reviewOnHead: boolean }
 *   fetchUnresolvedThreads(ctx)  -> Thread[]; each Thread =
 *       { id, path, line: number|null, isOutdated, commitSha,
 *         authorLogin, body }
 *   resolveThread(ctx, threadId) -> mutation data (provider-specific)
 *   ciStateOnHead(ctx)           -> one of the ciState enum values
 */
export const REVIEW_METHODS = Object.freeze([
  "requestReview",
  "pollForReview",
  "fetchUnresolvedThreads",
  "resolveThread",
  "ciStateOnHead",
]);

/**
 * Names of the top-level tracker namespaces a Tracker exposes. Each
 * namespace groups related operations so stubs can be generated
 * uniformly and so callers that need one capability don't need to
 * import the whole surface.
 *
 *   review:   the pr-iteration subset (see REVIEW_METHODS above)
 *   issues:   create / update / comment / relabel / close issues
 *   projects: project board field / status moves (GitHub v2 style;
 *             mapped to the native equivalent on other trackers)
 *   labels:   taxonomy reconcile
 *
 * Non-review namespaces are stubbed on the github impl for PR 3
 * (legacy github-sync markdown contract moves onto the real impl in
 * follow-up work). Listed here so stubs can synthesise a complete
 * no-op surface and so tests can assert coverage.
 */
export const TRACKER_NAMESPACES = Object.freeze({
  review: REVIEW_METHODS,
  // Rest are declared for shape parity so makeStubTracker() can
  // produce a uniform NotSupportedError-throwing surface across
  // every non-github kind. The github impl will fill these in as
  // the github-sync contract is ported onto the Tracker surface.
  issues: Object.freeze([
    "createIssue",
    "updateIssueStatus",
    "comment",
    "relabelIssue",
    "getIssue",
    "listIssues",
  ]),
  projects: Object.freeze([
    "listProjectItems",
    "updateProjectField",
    "reconcileProjectFields",
  ]),
  labels: Object.freeze(["reconcileLabels", "relabelBulk"]),
});
