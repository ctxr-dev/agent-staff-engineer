// lib/review/provider.mjs
// The `ReviewProvider` interface: a duck-typed contract every concrete
// review-iteration backend implements. Used by the `pr-iteration` skill
// to drive the post-push loop (request external review, poll for CI +
// review, fetch unresolved threads, triage, resolve).
//
// Concrete implementations:
//   - github.mjs  — full impl backed by `gh api graphql` mutations.
//   - stub.mjs    — declines every op with NotSupportedError. Used for
//                   tracker kinds where the loop has not been implemented
//                   yet (Jira, Linear, GitLab as of v1).
//
// The dispatcher (dispatcher.mjs) picks a provider from
// `ops.config.json -> trackers.dev.kind` (or the legacy top-level
// `github:` block, as a transitional shim until PR 3 removes it).
//
// ctx object each method accepts:
//   {
//     owner:      string    // tracker-side owner (GitHub owner, Jira site, ...)
//     repo:       string    // tracker-side repo / project key
//     prNumber:   number    // pull-request / merge-request / change number
//     headSha:    string    // current HEAD SHA on the feature branch
//     prNodeId?:  string    // GraphQL node ID (GitHub); cached across rounds
//     botIds?:    string[]  // reviewer node IDs (GitHub); passed to
//                             requestReviews mutations (captured once per
//                             repo per rules/pr-iteration.md).
//     botLogins?: string[]  // reviewer logins (GitHub); used by
//                             pollForReview to narrow `reviewOnHead` to
//                             the configured external reviewer. When
//                             empty the provider falls back to "any
//                             Bot-typed author on HEAD" which works
//                             for the common single-bot case.
//   }

/**
 * Thrown by ReviewProvider implementations that don't support a given
 * operation on the current tracker kind. Carries `kind` and `op` for
 * useful diagnostics at the skill level.
 */
export class NotSupportedError extends Error {
  constructor(message, { kind = null, op = null } = {}) {
    super(message);
    this.name = "NotSupportedError";
    this.kind = kind;
    this.op = op;
  }
}

/**
 * Names of the methods every ReviewProvider implementation must expose.
 * Exported so tests can assert method coverage without hard-coding the list
 * in multiple places, and so the stub can iterate and produce identical
 * NotSupportedError throwers for each one.
 *
 * Semantics:
 *   requestReview(ctx)           -> register external reviewer on HEAD
 *   pollForReview(ctx)           -> one-shot probe; returns
 *       { ciState: "SUCCESS"|"FAILURE"|"ERROR"|"PENDING",
 *         unresolvedCount: number, reviewOnHead: boolean }
 *   fetchUnresolvedThreads(ctx)  -> Thread[]; each Thread =
 *       { id, path, line: number|null, isOutdated, commitSha,
 *         authorLogin, body }
 *       `line` may be null for file-level threads or otherwise
 *       unanchored comments; consumers must handle that case and
 *       must not assume `${path}:${line}` is always formattable.
 *       `isOutdated` = the anchor line has moved since the comment
 *       was posted (GitHub surfaces this flag; providers should
 *       best-effort map their native equivalent for stale-triage).
 *   resolveThread(ctx, threadId) -> mutation data (provider-specific).
 *       Callers typically ignore the return value; the side effect
 *       (thread resolved on the tracker) is what matters.
 *   ciStateOnHead(ctx)           -> one of the ciState enum values
 */
export const REVIEW_PROVIDER_METHODS = Object.freeze([
  "requestReview",
  "pollForReview",
  "fetchUnresolvedThreads",
  "resolveThread",
  "ciStateOnHead",
]);
