// lib/review/dispatcher.mjs
// Pick a ReviewProvider for the pr-iteration loop.
//
// Today the only concrete backend is GitHub (github.mjs). Every other
// kind gets the stub (stub.mjs), which throws NotSupportedError on every
// operation. PR 3's multi-tracker refactor adds jira/linear/gitlab
// backends and replaces the stub calls as they land.
//
// Precedence (highest to lowest):
//   1. `workflow.external_review.provider` when it's "github" / "none"
//      — explicit override from the user, e.g. "code lives on GitHub
//      but tickets are elsewhere, so force GitHub for review".
//   2. `workflow.external_review.provider === "auto"` -> fall through.
//   3. `trackers.dev.kind` (new shape).
//   4. Top-level legacy `github:` block (pre-PR-3 shim; PR 3 removes).
//   5. "unknown" -> stub.

import { makeGithubReviewProvider } from "./github.mjs";
import { makeStubProvider } from "./stub.mjs";

/**
 * @param {object} opsConfig parsed ops.config.json (or a minimal subset)
 * @returns {{ provider: object, kind: string }}
 */
export function pickReviewProvider(opsConfig) {
  const kind = resolveReviewProviderKind(opsConfig);
  if (kind === "github") {
    return { provider: makeGithubReviewProvider(), kind };
  }
  return { provider: makeStubProvider(kind), kind };
}

/**
 * Resolve the review provider kind honoring
 * `workflow.external_review.provider` before tracker-based inference.
 *
 * Supported override values:
 *   - "github" — force the GitHub provider
 *   - "none"   — explicitly opt out by returning the distinct "none"
 *                kind. pickReviewProvider currently still backs every
 *                non-"github" kind (including "none") with the stub
 *                so every op throws NotSupportedError; the skill is
 *                expected to short-circuit on `kind === "none"`
 *                before touching provider methods. If a future change
 *                needs a hard null provider for "none", do it in
 *                pickReviewProvider + tests together, don't diverge
 *                the doc-string.
 *   - "auto"   — use tracker-based inference (same as omitting the key)
 *
 * Any other string falls back to inference for forward compat.
 */
export function resolveReviewProviderKind(cfg) {
  const overrideRaw = cfg?.workflow?.external_review?.provider;
  if (typeof overrideRaw === "string" && overrideRaw.length > 0) {
    const override = overrideRaw.toLowerCase();
    if (override === "github" || override === "none") return override;
    // "auto" (and any unknown value) falls through to inference.
  }
  return resolveTrackerKind(cfg);
}

/** @returns {string} tracker kind, lower-case; "unknown" when nothing declared. */
export function resolveTrackerKind(cfg) {
  const newKind = cfg?.trackers?.dev?.kind;
  if (typeof newKind === "string" && newKind.length > 0) {
    return newKind.toLowerCase();
  }
  // Legacy shim: any pre-PR-3 config had a top-level `github:` block.
  // Tighten so `github: null`, `github: []`, `github: "str"`, or
  // `github: {}` do NOT count as a valid GitHub config; they would
  // otherwise surface confusing errors deep in the github provider.
  const legacy = cfg && typeof cfg === "object" ? cfg.github : null;
  if (
    legacy &&
    typeof legacy === "object" &&
    !Array.isArray(legacy) &&
    Object.keys(legacy).length > 0
  ) {
    return "github";
  }
  return "unknown";
}
