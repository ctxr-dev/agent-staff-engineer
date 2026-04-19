// lib/review/dispatcher.mjs
// Pick a ReviewProvider from the tracker kind declared in ops.config.json.
//
// Today the only concrete backend is GitHub (github.mjs). Every other
// kind gets the stub (stub.mjs), which throws NotSupportedError on every
// operation. PR 3's multi-tracker refactor adds jira/linear/gitlab
// backends and replaces the stub calls as they land.
//
// Legacy shim: ops.config.json files produced before PR 3 carry a
// top-level `github:` block instead of `trackers.dev.kind`. We infer
// `github` in that case so existing installs continue to work through
// PR 2. PR 3 removes this branch at the same time it introduces the
// hard break on config migration.

import { makeGithubReviewProvider } from "./github.mjs";
import { makeStubProvider } from "./stub.mjs";

/**
 * @param {object} opsConfig parsed ops.config.json (or a minimal subset
 *   carrying either `trackers.dev.kind` or a top-level `github` block)
 * @returns {{ provider: object, kind: string }}
 */
export function pickReviewProvider(opsConfig) {
  const kind = resolveTrackerKind(opsConfig);
  if (kind === "github") {
    return { provider: makeGithubReviewProvider(), kind };
  }
  return { provider: makeStubProvider(kind), kind };
}

/** @returns {string} tracker kind, lower-case; "unknown" when nothing declared. */
export function resolveTrackerKind(cfg) {
  const newKind = cfg?.trackers?.dev?.kind;
  if (typeof newKind === "string" && newKind.length > 0) {
    return newKind.toLowerCase();
  }
  // Legacy shim: any pre-PR-3 config had a top-level `github:` block.
  if (cfg && typeof cfg === "object" && Object.hasOwn(cfg, "github")) {
    return "github";
  }
  return "unknown";
}
