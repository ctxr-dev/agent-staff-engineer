// lib/trackers/dispatcher.mjs
// Resolve a Tracker from an ops.config.json and a role. This is the
// one and only entry point callers (skills, scripts, tests) use to
// turn config into a live Tracker object. There is no legacy fallback:
// a config without a `trackers:` block is a schema-validation error
// surfaced by scripts/lib/schema.mjs before any skill runs.
//
// Precedence (for pickReviewProvider only):
//   1. `workflow.external_review.provider` override:
//        "none"    -> dedicated stub whose every review method throws
//                     NotSupportedError tagged with kind="none".
//        "github"  -> force the GitHub review impl even when
//                     trackers.dev.kind is elsewhere. Useful for
//                     projects whose tickets live on Jira but whose
//                     code review happens on GitHub.
//        "auto" or omitted -> fall through to tracker-based inference.
//      Any other string is treated as "auto" for forward-compat.
//   2. `trackers.dev.kind` -> the corresponding Tracker factory.

import { makeGithubTracker } from "./github.mjs";
import { makeJiraTracker } from "./jira.mjs";
import { makeLinearTracker } from "./linear.mjs";
import { makeGitlabTracker } from "./gitlab.mjs";
import { makeStubTracker } from "./stub.mjs";

const SUPPORTED_KINDS = Object.freeze(["github", "jira", "linear", "gitlab"]);

/**
 * Build a Tracker for the named role.
 *
 * @param {object} cfg  parsed ops.config.json
 * @param {"dev"|"release"} [role="dev"]
 * @returns {{ tracker: object, kind: string }}
 */
export function pickTracker(cfg, role = "dev") {
  if (role !== "dev" && role !== "release") {
    throw new Error(`pickTracker: role must be "dev" or "release"; got ${JSON.stringify(role)}`);
  }
  const target = cfg?.trackers?.[role];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(
      `pickTracker: ops.config.json is missing trackers.${role} (must be an object with a 'kind' discriminator)`,
    );
  }
  const kind = target.kind;
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw new Error(
      `pickTracker: unsupported tracker kind '${kind}' for role '${role}' (supported: ${SUPPORTED_KINDS.join(", ")})`,
    );
  }
  return { tracker: makeTracker(kind, target), kind };
}

/**
 * Pick the review provider for the pr-iteration loop. Honors the
 * `workflow.external_review.provider` override (see module header).
 *
 * @param {object} cfg  parsed ops.config.json
 * @returns {{ provider: object, kind: string }}  provider is the
 *   Tracker's `.review` namespace; kind is the resolved tracker kind
 *   or "none" when the override opts out.
 */
export function pickReviewProvider(cfg) {
  const overrideRaw = cfg?.workflow?.external_review?.provider;
  if (typeof overrideRaw === "string" && overrideRaw.length > 0) {
    const override = overrideRaw.toLowerCase();
    if (override === "none") {
      return { provider: makeStubTracker("none").review, kind: "none" };
    }
    if (override === "github") {
      // Override synthesises a minimal github tracker: review methods
      // take all their runtime fields from ctx at call time, so an
      // empty target is fine. A downstream caller that also wants
      // issues/projects/labels should go through pickTracker(cfg).
      return { provider: makeGithubTracker().review, kind: "github" };
    }
    // "auto" and unknown values fall through to tracker-based inference.
  }
  const { tracker, kind } = pickTracker(cfg, "dev");
  return { provider: tracker.review, kind };
}

/**
 * Return the dev tracker kind without constructing a Tracker. Used by
 * callers that only need the kind string (logging, branch naming,
 * skill routing decisions). Throws the same errors as pickTracker if
 * the config is malformed.
 */
export function resolveTrackerKind(cfg, role = "dev") {
  const { kind } = pickTracker(cfg, role);
  return kind;
}

function makeTracker(kind, target) {
  switch (kind) {
    case "github": return makeGithubTracker(target);
    case "jira":   return makeJiraTracker(target);
    case "linear": return makeLinearTracker(target);
    case "gitlab": return makeGitlabTracker(target);
    /* istanbul ignore next — SUPPORTED_KINDS guard above makes this unreachable */
    default: throw new Error(`makeTracker: unreachable kind '${kind}'`);
  }
}
