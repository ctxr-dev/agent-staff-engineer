// lib/trackers/stub.mjs
// Factory that builds a complete Tracker whose every namespace method
// throws NotSupportedError. Used by the Jira / Linear / GitLab
// placeholder trackers so every op surfaces a clean, kind-tagged
// error message without each placeholder repeating the boilerplate.
//
// Shape parity with a real Tracker is important: tests assert every
// Tracker exposes the same namespace keys (review, issues, projects,
// labels). A stub that only set a subset of namespaces would let a
// caller hit a bare `TypeError: cannot read review of undefined`
// before the error message has a chance to explain what's missing.

import { NotSupportedError, TRACKER_NAMESPACES } from "./tracker.mjs";

/**
 * @param {string} kind  tracker kind ("jira", "linear", "gitlab")
 * @param {object} [target]  ops.config trackers entry; kept for shape
 *   parity with real impls so stub-vs-real is substitutable.
 */
export function makeStubTracker(kind, target = {}) {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError("makeStubTracker: kind must be a non-empty string");
  }
  const tracker = { kind, target };
  for (const [namespace, methods] of Object.entries(TRACKER_NAMESPACES)) {
    tracker[namespace] = {};
    for (const op of methods) {
      // Async so the contract matches the real providers; a caller
      // doing `tracker.review.pollForReview(ctx).catch(...)` would
      // crash synchronously before getting a Promise back.
      tracker[namespace][op] = async () => {
        throw new NotSupportedError(
          `tracker '${kind}' does not implement '${namespace}.${op}' yet; see skills/tracker-sync/SKILL.md for the current surface`,
          { kind, op, namespace },
        );
      };
    }
  }
  return tracker;
}
