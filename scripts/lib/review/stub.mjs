// lib/review/stub.mjs
// ReviewProvider implementation that declines every operation. Returned by
// the dispatcher when `trackers.dev.kind` is a tracker for which the native
// review-iteration loop has not been implemented yet (Jira, Linear, GitLab
// as of v1). Every method throws `NotSupportedError` with a consistent
// message that names the kind and the operation, so callers can catch and
// surface a clean "not supported" message without type-sniffing.
//
// The stub is a single factory per kind so two `pickReviewProvider()`
// calls with the same kind return interchangeable instances.

import { NotSupportedError, REVIEW_PROVIDER_METHODS } from "./provider.mjs";

/** @param {string} kind tracker kind (e.g. "jira", "linear") */
export function makeStubProvider(kind) {
  const impl = {};
  for (const op of REVIEW_PROVIDER_METHODS) {
    impl[op] = () => {
      throw new NotSupportedError(
        `pr-iteration review loop is not implemented for tracker kind '${kind}' yet; see rules/pr-iteration.md fallback`,
        { kind, op },
      );
    };
  }
  return impl;
}
