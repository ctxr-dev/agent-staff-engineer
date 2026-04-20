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
 * Cheap probe: does the config declare a release tracker? The `release`
 * key is optional on `trackers:` — teams that don't use release
 * umbrellas (solo / continuous deploy / milestone-based workflows)
 * omit it and the release-tracker + dev-loop consumers short-circuit
 * on absence. This helper lets callers check the presence without
 * having to catch pickTracker's "missing trackers.release" throw.
 *
 * @param {object} cfg parsed ops.config.json
 * @returns {boolean} true if `trackers.release` is a non-null object with a `kind`.
 */
export function hasReleaseTracker(cfg) {
  const target = cfg?.trackers?.release;
  return (
    Boolean(target) &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    typeof target.kind === "string" &&
    target.kind.length > 0
  );
}

/**
 * Return the tracker kind for the named role without constructing a
 * Tracker. Used by callers that only need the kind string (logging,
 * branch naming, skill routing decisions). Performs the same config
 * validation as pickTracker (role check, trackers.<role> presence
 * check, supported-kind check) but stops before calling any factory,
 * so malformed / unsupported-kind configs still raise with the same
 * pointed errors.
 */
export function resolveTrackerKind(cfg, role = "dev") {
  if (role !== "dev" && role !== "release") {
    throw new Error(`resolveTrackerKind: role must be "dev" or "release"; got ${JSON.stringify(role)}`);
  }
  const target = cfg?.trackers?.[role];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(
      `resolveTrackerKind: ops.config.json is missing trackers.${role} (must be an object with a 'kind' discriminator)`,
    );
  }
  const { kind } = target;
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw new Error(
      `resolveTrackerKind: unsupported tracker kind '${kind}' for role '${role}' (supported: ${SUPPORTED_KINDS.join(", ")})`,
    );
  }
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

/**
 * Build a Tracker for a specific workspace member + role. Callers pass
 * a member `name` (as recorded in `cfg.workspace.members[].name`); when
 * `memberName === null` or `cfg.workspace` is absent, the call falls
 * through to the project-level `pickTracker(cfg, role)` so single-repo
 * projects do not need to change their call sites.
 *
 * A member whose `trackers.<role>` is missing is an error, not a
 * silent fallback to the project-level tracker: the member declared
 * itself in the workspace but did not bind a tracker for this role,
 * which is almost always a bootstrap bug the user should see. If you
 * truly want a member to inherit the top-level tracker, omit it from
 * `workspace.members[]` entirely.
 *
 * @param {object} cfg          parsed ops.config.json
 * @param {string|null} memberName  workspace member name, or null for root
 * @param {"dev"|"release"} [role="dev"]
 * @returns {{ tracker: object, kind: string, memberName: string|null }}
 */
export function pickTrackerForMember(cfg, memberName, role = "dev") {
  if (role !== "dev" && role !== "release") {
    throw new Error(`pickTrackerForMember: role must be "dev" or "release"; got ${JSON.stringify(role)}`);
  }
  if (memberName === null || memberName === undefined) {
    const { tracker, kind } = pickTracker(cfg, role);
    return { tracker, kind, memberName: null };
  }
  const members = cfg?.workspace?.members;
  if (!Array.isArray(members) || members.length === 0) {
    // A memberName was supplied but the config has no workspace block.
    // This is a caller bug: surface it rather than silently routing
    // through the root tracker, which would mask the missing workspace.
    throw new Error(
      `pickTrackerForMember: memberName='${memberName}' was requested but cfg.workspace.members is absent or empty`,
    );
  }
  // Collect every member with the requested name rather than calling
  // Array.find. Bootstrap already rejects duplicate names at prompt
  // time, but a hand-edited config can reintroduce them; silently
  // picking the first match would make dispatch ambiguous in a way
  // that's almost impossible to debug at runtime. Treat duplicates as
  // a hard error listing both offending entries (by index) so the
  // user can fix the config.
  const matches = [];
  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    if (m && m.name === memberName) matches.push({ member: m, index: i });
  }
  if (matches.length === 0) {
    const known = members.map((m) => m?.name).filter(Boolean).join(", ");
    throw new Error(
      `pickTrackerForMember: unknown workspace member '${memberName}' (known: ${known || "<none>"})`,
    );
  }
  if (matches.length > 1) {
    const collisions = matches.map(({ index }) => `members[${index}]`).join(", ");
    throw new Error(
      `pickTrackerForMember: duplicate workspace member name '${memberName}' makes dispatch ambiguous (${collisions})`,
    );
  }
  const member = matches[0].member;
  const target = member.trackers?.[role];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(
      `pickTrackerForMember: workspace member '${memberName}' is missing trackers.${role}`,
    );
  }
  const kind = target.kind;
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw new Error(
      `pickTrackerForMember: member '${memberName}' declares unsupported tracker kind '${kind}' for role '${role}' (supported: ${SUPPORTED_KINDS.join(", ")})`,
    );
  }
  return { tracker: makeTracker(kind, target), kind, memberName };
}

/**
 * Resolve the workspace member that owns a given project-relative file
 * path. Returns the member `name`, or `null` if no member declares a
 * path that contains the file (single-repo projects always return
 * null). Matching is deepest-first, so a file under `libs/shared/x.ts`
 * resolves to the `libs/shared` member even when `.` also declares
 * itself as a member.
 *
 * **Root shorthand (`.` / `./`) applies to member.path normalisation
 * only**, where a declared member with that path is canonicalised to
 * `.` and becomes the weakest possible match. The `filePath` argument,
 * in contrast, must be a real project-relative POSIX **file** path:
 * inputs like `.` and `./` are rejected by
 * `normaliseMemberPath(..., allowRoot=false)` because a "file" at the
 * project root makes no sense for path-based dispatch.
 *
 * This helper is consumed by dev-loop / pr-iteration before they pick a
 * tracker: given the set of files changed on the current branch, the
 * agent picks the deepest containing member and dispatches through it.
 *
 * @param {object} cfg       parsed ops.config.json
 * @param {string} filePath  project-relative POSIX file path (no leading slash, no `..`, not the root shorthand `.`/`./`)
 * @returns {string|null}    matched member's name, or null
 */
export function resolveMemberFromPath(cfg, filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("resolveMemberFromPath: filePath must be a non-empty string");
  }
  const members = cfg?.workspace?.members;
  if (!Array.isArray(members) || members.length === 0) return null;

  // Normalise the caller-supplied file path. Member paths get the
  // same normalisation below so "libs\\shared" in ops.config.json
  // matches "libs/shared/x.ts" from a git diff.
  const norm = normaliseMemberPath(filePath, "filePath");

  // Rank each member's path by how many leading path segments match
  // the file's segments. Ties and zero-match misses are discarded.
  // "." matches everything with length 0 (the weakest signal).
  const fileParts = norm.split("/");
  let best = { name: null, depth: -1 };
  for (const m of members) {
    if (!m || typeof m.path !== "string" || typeof m.name !== "string") continue;
    // Member paths are normalised the same way as file paths so a
    // Windows user who typed "libs\\shared" in the interview still
    // resolves to POSIX-diff input "libs/shared/x.ts". Bad member
    // paths (absolute, parent-traversal, empty-after-normalise) are
    // caught at install-time preflight and bootstrap prompt-time, so
    // a throw here is a config-loaded-mid-session edge case: treat
    // it as "skip this member" rather than abort the whole resolve.
    let memberPath;
    try {
      memberPath = normaliseMemberPath(m.path, `member '${m.name}' path`, { allowRoot: true });
    } catch {
      continue;
    }
    if (memberPath === ".") {
      // Root member: weakest match, length 0.
      if (best.depth < 0) best = { name: m.name, depth: 0 };
      continue;
    }
    const memberParts = memberPath.split("/");
    if (memberParts.length > fileParts.length) continue;
    let matches = true;
    for (let i = 0; i < memberParts.length; i += 1) {
      if (memberParts[i] !== fileParts[i]) { matches = false; break; }
    }
    if (matches && memberParts.length > best.depth) {
      best = { name: m.name, depth: memberParts.length };
    }
  }
  return best.name;
}

/**
 * Canonical normalisation for workspace member paths and the file
 * paths passed to `resolveMemberFromPath`. Exported so bootstrap and
 * install can reuse the same contract at prompt-time and preflight,
 * rather than each round-tripping through slightly-different ad-hoc
 * regex and later disagreeing.
 *
 * Contract:
 *   - Converts backslashes to forward slashes (Windows paths typed
 *     into the bootstrap interview or checked-in configs).
 *   - Strips a leading `./` and trailing `/`.
 *   - Rejects absolute paths (leading `/` after normalisation or a
 *     Windows drive prefix like `C:/`).
 *   - Rejects any `..` segment.
 *   - Rejects collapse-to-empty (e.g. `./`, `////`).
 *   - When `allowRoot` is true, the inputs `.` and `./` resolve to
 *     `.` instead of throwing. File paths never set this flag (a
 *     file "." makes no sense); member paths always do.
 *
 * @param {string} input     raw path
 * @param {string} label     prefix for error messages
 * @param {{allowRoot?: boolean}} [opts]
 * @returns {string}         normalised POSIX path, or `.` for root member
 */
export function normaliseMemberPath(input, label, opts = {}) {
  const { allowRoot = false } = opts;
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`normaliseMemberPath: ${label} must be a non-empty string`);
  }
  // Reject Windows drive prefixes up front so the later "no leading /"
  // check doesn't accidentally let `C:\foo` through (the backslash
  // conversion would turn it into `C:/foo`, which has no leading
  // slash but still resolves to an absolute drive path on Windows).
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error(`normaliseMemberPath: ${label} must be project-relative (got drive path '${input}')`);
  }
  // Normalise separators first so the rest of the checks are
  // POSIX-only. An input of `libs\\shared` becomes `libs/shared`.
  const withForward = input.replace(/\\/g, "/");
  // Handle absolute paths BEFORE stripping leading "./" so the error
  // message distinguishes "/absolute" from "./foo".
  if (withForward.startsWith("/")) {
    throw new Error(`normaliseMemberPath: ${label} must be project-relative (got absolute path '${input}')`);
  }
  // Root-member shorthand. "." and "./" (or any ".//" variant) are
  // the canonical ways to bind a member to the project root. They
  // need special handling because the strip-leading-"./" regex below
  // leaves "." as-is but collapses "./" to "". Canonicalise both to
  // "." when allowRoot is set; reject otherwise since a non-root
  // caller (like a file path) never meaningfully maps to the root.
  const rootOnly = withForward === "." || /^\.\/+$/.test(withForward);
  if (rootOnly) {
    if (allowRoot) return ".";
    throw new Error(`normaliseMemberPath: ${label} collapses to empty after normalisation (got '${input}')`);
  }
  const stripped = withForward.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (stripped.length === 0) {
    // e.g. "////" or ".////" that didn't match rootOnly above.
    throw new Error(`normaliseMemberPath: ${label} collapses to empty after normalisation (got '${input}')`);
  }
  // Collapse consecutive separators ("libs//shared" -> "libs/shared")
  // and drop interior "." segments ("libs/./shared" -> "libs/shared").
  // Without this the normaliser would accept inputs that look fine
  // at bootstrap time but never match a real git-diff file path at
  // runtime (diffs always emit canonical POSIX with single slashes
  // and no "./" segments), breaking resolveMemberFromPath silently.
  const parts = stripped.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (parts.length === 0) {
    // Input was composed entirely of "." and "/" segments (e.g.
    // "././", ".//./"). That's semantically the root member; honour
    // allowRoot here the same way as the early rootOnly shortcut so
    // a caller can't sneak a "sort-of root" input past the guard.
    if (allowRoot) return ".";
    throw new Error(`normaliseMemberPath: ${label} collapses to empty after normalisation (got '${input}')`);
  }
  if (parts.includes("..")) {
    throw new Error(`normaliseMemberPath: ${label} must not contain '..' (got '${input}')`);
  }
  return parts.join("/");
}
