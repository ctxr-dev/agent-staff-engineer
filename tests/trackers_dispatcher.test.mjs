// trackers_dispatcher.test.mjs
// Unit tests for the tracker dispatcher. After PR 3's clean-break
// refactor there is no legacy top-level `github:` shim: the dispatcher
// reads only `trackers.{dev,release}` and raises on malformed config.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickTracker,
  pickReviewProvider,
  resolveTrackerKind,
  hasReleaseTracker,
  pickTrackerForMember,
  resolveMemberFromPath,
  normaliseMemberPath,
} from "../scripts/lib/trackers/dispatcher.mjs";
import {
  NotSupportedError,
  REVIEW_METHODS,
} from "../scripts/lib/trackers/tracker.mjs";

const GITHUB_DEV = {
  trackers: {
    dev: { kind: "github", owner: "acme", repo: "widgets", projects: [] },
    release: { kind: "github", owner: "acme", projects: [] },
  },
};
const JIRA_DEV = {
  trackers: {
    dev: {
      kind: "jira",
      site: "acme.atlassian.net",
      project: "PLAT",
      status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" },
    },
    release: { kind: "github", owner: "acme", projects: [] },
  },
};

describe("pickTracker: dispatches by kind", () => {
  it("returns the GitHub impl when trackers.dev.kind === 'github'", () => {
    const { tracker, kind } = pickTracker(GITHUB_DEV, "dev");
    assert.equal(kind, "github");
    for (const op of REVIEW_METHODS) {
      assert.equal(typeof tracker.review[op], "function", `github tracker missing review.${op}`);
    }
  });

  it("returns a stub for jira/linear/gitlab (NotSupportedError on every op)", async () => {
    for (const kind of ["jira", "linear", "gitlab"]) {
      const cfg = {
        trackers: {
          dev: {
            kind,
            ...(kind === "jira" && { site: "x.atlassian.net", project: "X", status_values: { backlog: "B", in_progress: "I", done: "D" } }),
            ...(kind === "linear" && { workspace: "x", team: "X", status_values: { backlog: "B", in_progress: "I", done: "D" } }),
            ...(kind === "gitlab" && { host: "gitlab.com", project_path: "a/b", status_values: { backlog: "B", in_progress: "I", done: "D" } }),
          },
          release: { kind: "github", owner: "x", projects: [] },
        },
      };
      const { tracker, kind: resolved } = pickTracker(cfg, "dev");
      assert.equal(resolved, kind);
      await assert.rejects(
        () => tracker.review.requestReview({}),
        (err) => err instanceof NotSupportedError && err.kind === kind,
      );
    }
  });

  it("defaults role to 'dev' when omitted", () => {
    const { kind } = pickTracker(GITHUB_DEV);
    assert.equal(kind, "github");
  });

  it("dispatches release role when requested", () => {
    const { kind } = pickTracker(GITHUB_DEV, "release");
    assert.equal(kind, "github");
  });

  it("throws on missing trackers.<role> block", () => {
    assert.throws(() => pickTracker({}, "dev"), /trackers\.dev/);
    assert.throws(() => pickTracker({ trackers: {} }, "dev"), /trackers\.dev/);
    assert.throws(() => pickTracker({ trackers: { dev: null } }, "dev"), /trackers\.dev/);
    assert.throws(() => pickTracker({ trackers: { dev: [] } }, "dev"), /trackers\.dev/);
    assert.throws(() => pickTracker({ trackers: { dev: "github" } }, "dev"), /trackers\.dev/);
  });

  it("throws on unsupported kind", () => {
    assert.throws(
      () => pickTracker({ trackers: { dev: { kind: "bitbucket" } } }, "dev"),
      /unsupported tracker kind 'bitbucket'/,
    );
  });

  it("refuses bad role argument", () => {
    assert.throws(() => pickTracker(GITHUB_DEV, "observed"), /role must be/);
    assert.throws(() => pickTracker(GITHUB_DEV, ""), /role must be/);
  });
});

describe("pickReviewProvider: honours workflow.external_review.provider override", () => {
  it("returns the stub with kind='none' when override is 'none'", async () => {
    const cfg = { ...GITHUB_DEV, workflow: { external_review: { provider: "none" } } };
    const { provider, kind } = pickReviewProvider(cfg);
    assert.equal(kind, "none");
    await assert.rejects(() => provider.requestReview({}), NotSupportedError);
  });

  it("forces GitHub even when trackers.dev.kind is elsewhere (code-on-github / tickets-on-jira)", async () => {
    const cfg = { ...JIRA_DEV, workflow: { external_review: { provider: "github" } } };
    const { provider, kind } = pickReviewProvider(cfg);
    assert.equal(kind, "github");
    // A github provider called with empty botIds throws GitHub's own guard
    // error, not NotSupportedError. A mutant that silently routed to the
    // stub would throw NotSupportedError here.
    await assert.rejects(
      () => provider.requestReview({ owner: "o", repo: "r", prNumber: 1, headSha: "x", prNodeId: "PR_", botIds: [] }),
      (err) => err.name !== "NotSupportedError" && /botIds is empty/.test(err.message),
    );
  });

  it("falls through to tracker inference when override is 'auto'", () => {
    const cfg = { ...GITHUB_DEV, workflow: { external_review: { provider: "auto" } } };
    const { kind } = pickReviewProvider(cfg);
    assert.equal(kind, "github");
  });

  it("treats unknown override strings as 'auto' (forward-compat)", () => {
    const cfg = { ...GITHUB_DEV, workflow: { external_review: { provider: "bitbucket" } } };
    const { kind } = pickReviewProvider(cfg);
    assert.equal(kind, "github");
  });

  it("infers from trackers.dev.kind when no override is set", () => {
    const { kind } = pickReviewProvider(GITHUB_DEV);
    assert.equal(kind, "github");
  });

  it("raises on missing trackers.dev when override is absent (no legacy fallback)", () => {
    assert.throws(() => pickReviewProvider({}), /trackers\.dev/);
  });
});

describe("resolveTrackerKind", () => {
  it("returns the kind string without constructing a tracker", () => {
    assert.equal(resolveTrackerKind(GITHUB_DEV, "dev"), "github");
    assert.equal(resolveTrackerKind(JIRA_DEV, "dev"), "jira");
    assert.equal(resolveTrackerKind(GITHUB_DEV, "release"), "github");
  });

  it("propagates pickTracker's errors on malformed config", () => {
    assert.throws(() => resolveTrackerKind({}, "dev"), /trackers\.dev/);
  });
});

// PR 7 R3 (Copilot): hasReleaseTracker is the new cheap probe consumers
// use to short-circuit on the "team opted out of release umbrellas"
// path without having to catch pickTracker's "missing trackers.release"
// throw. Lock the probe semantics: true only for a non-null object with
// a non-empty string `kind`; everything else (missing, null, array,
// primitive, empty kind) is false. This prevents regressions where a
// future change loosens the check and consumers unintentionally try to
// construct a tracker from a garbage value.
describe("hasReleaseTracker", () => {
  it("returns true when trackers.release is a valid kind-discriminator object", () => {
    assert.equal(hasReleaseTracker(GITHUB_DEV), true);
    assert.equal(hasReleaseTracker(JIRA_DEV), true);
  });

  it("returns false when trackers.release is absent", () => {
    assert.equal(hasReleaseTracker({ trackers: { dev: { kind: "github" } } }), false);
  });

  it("returns false when trackers block itself is missing", () => {
    assert.equal(hasReleaseTracker({}), false);
    assert.equal(hasReleaseTracker({ project: {} }), false);
  });

  it("returns false when cfg is null or undefined", () => {
    assert.equal(hasReleaseTracker(null), false);
    assert.equal(hasReleaseTracker(undefined), false);
  });

  it("returns false when trackers.release is null", () => {
    assert.equal(hasReleaseTracker({ trackers: { release: null } }), false);
  });

  it("returns false when trackers.release is an array (not a plain object)", () => {
    assert.equal(hasReleaseTracker({ trackers: { release: [{ kind: "github" }] } }), false);
  });

  it("returns false when trackers.release has no `kind` string", () => {
    assert.equal(hasReleaseTracker({ trackers: { release: {} } }), false);
    assert.equal(hasReleaseTracker({ trackers: { release: { kind: "" } } }), false);
    assert.equal(hasReleaseTracker({ trackers: { release: { kind: 42 } } }), false);
  });
});

// PR 8: workspace multi-repo dispatch. Two new helpers for projects
// that bind multiple sibling repos (mid-migration monorepos, toolchain
// workspaces). Single-repo projects MUST keep working without change;
// that is the core compatibility contract locked by these tests.
const WORKSPACE_CFG = {
  trackers: {
    dev: { kind: "github", owner: "acme", repo: "primary", projects: [] },
    release: { kind: "github", owner: "acme", projects: [] },
  },
  workspace: {
    members: [
      {
        path: ".",
        name: "primary",
        trackers: {
          dev: { kind: "github", owner: "acme", repo: "primary", projects: [] },
        },
      },
      {
        path: "libs/shared",
        name: "shared",
        trackers: {
          dev: { kind: "jira", site: "acme.atlassian.net", project: "SHARED", status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" } },
          release: { kind: "github", owner: "acme", projects: [] },
        },
      },
    ],
  },
};

describe("pickTrackerForMember: workspace dispatch", () => {
  it("falls back to pickTracker(cfg, role) when memberName is null", () => {
    const { tracker, kind, memberName } = pickTrackerForMember(GITHUB_DEV, null, "dev");
    assert.equal(kind, "github");
    assert.equal(memberName, null);
    assert.equal(typeof tracker, "object");
  });

  it("also falls back when memberName is undefined (positional call)", () => {
    const { kind, memberName } = pickTrackerForMember(GITHUB_DEV, undefined);
    assert.equal(kind, "github");
    assert.equal(memberName, null);
  });

  it("routes to the member-specific tracker when a valid memberName is passed", () => {
    const { kind, memberName } = pickTrackerForMember(WORKSPACE_CFG, "shared", "dev");
    assert.equal(kind, "jira", "member 'shared' declares kind=jira");
    assert.equal(memberName, "shared");
  });

  it("routes primary member (path='.') to its own tracker (not the root block)", () => {
    const { kind, memberName } = pickTrackerForMember(WORKSPACE_CFG, "primary", "dev");
    assert.equal(kind, "github");
    assert.equal(memberName, "primary");
  });

  it("throws when memberName is supplied but cfg.workspace is absent", () => {
    assert.throws(
      () => pickTrackerForMember(GITHUB_DEV, "shared"),
      /workspace\.members is absent or empty/,
    );
  });

  it("throws with a pointed 'unknown member' error listing known names", () => {
    assert.throws(
      () => pickTrackerForMember(WORKSPACE_CFG, "typo"),
      /unknown workspace member 'typo'.*primary.*shared/s,
    );
  });

  it("throws when the member does not declare the requested role", () => {
    // primary member declares only trackers.dev, not .release
    assert.throws(
      () => pickTrackerForMember(WORKSPACE_CFG, "primary", "release"),
      /member 'primary' is missing trackers\.release/,
    );
  });

  it("validates role just like pickTracker", () => {
    assert.throws(
      () => pickTrackerForMember(WORKSPACE_CFG, "shared", "observed"),
      /role must be "dev" or "release"/,
    );
  });

  // PR 8 R5 (Copilot): pickTrackerForMember previously used
  // `Array.find` which silently picks the first match if the
  // config somehow ended up with duplicate member names (hand-edit
  // after bootstrap's prompt-time rejection). Now hard-refuses with
  // a pointed error listing both colliding indices so the user
  // sees exactly which entries clash.
  it("throws on duplicate workspace member names (defence for hand-edited configs)", () => {
    const cfg = {
      workspace: {
        members: [
          { path: ".", name: "primary", trackers: { dev: { kind: "github", owner: "a", repo: "x", projects: [] } } },
          { path: "lib", name: "primary", trackers: { dev: { kind: "github", owner: "b", repo: "y", projects: [] } } },
        ],
      },
    };
    assert.throws(
      () => pickTrackerForMember(cfg, "primary"),
      /duplicate workspace member name 'primary'.*members\[0\].*members\[1\]/s,
    );
  });
});

describe("resolveMemberFromPath: workspace resolution", () => {
  it("returns null when cfg.workspace is absent (single-repo project)", () => {
    assert.equal(resolveMemberFromPath(GITHUB_DEV, "src/index.ts"), null);
  });

  it("returns null when workspace.members is empty", () => {
    assert.equal(resolveMemberFromPath({ workspace: { members: [] } }, "src/index.ts"), null);
  });

  it("resolves a file under a nested member path to that member", () => {
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "libs/shared/utils.ts"), "shared");
  });

  it("prefers the deepest matching member (nested wins over root)", () => {
    // libs/shared/x is under BOTH '.' (the primary root) and 'libs/shared'.
    // Deepest-first must pick the nested 'shared' member.
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "libs/shared/x.ts"), "shared");
  });

  it("falls back to the root member for files outside any nested member", () => {
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "src/main.ts"), "primary");
  });

  it("returns null when no member covers the file and there is no root member", () => {
    const noRoot = {
      workspace: {
        members: [
          {
            path: "libs/shared",
            name: "shared",
            trackers: { dev: { kind: "github", owner: "acme", repo: "s", projects: [] } },
          },
        ],
      },
    };
    assert.equal(resolveMemberFromPath(noRoot, "src/main.ts"), null);
  });

  it("normalises leading './' and trailing '/' in both file and member paths", () => {
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "./libs/shared/x.ts"), "shared");
    const trailingSlash = {
      workspace: {
        members: [
          {
            path: "libs/shared/",
            name: "shared",
            trackers: { dev: { kind: "github", owner: "acme", repo: "s", projects: [] } },
          },
        ],
      },
    };
    assert.equal(resolveMemberFromPath(trailingSlash, "libs/shared/x.ts"), "shared");
  });

  it("rejects absolute paths and parent-traversal as ambiguous", () => {
    assert.throws(
      () => resolveMemberFromPath(WORKSPACE_CFG, "/absolute/path.ts"),
      /project-relative/,
    );
    assert.throws(
      () => resolveMemberFromPath(WORKSPACE_CFG, "../escape/path.ts"),
      /'\.\.'/,
    );
  });

  it("does NOT match a prefix-only path that doesn't break on a segment boundary", () => {
    // `libs/shared-v2/x.ts` must NOT match `libs/shared` — the member
    // path must align with path segments, not raw string prefixes.
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "libs/shared-v2/x.ts"), "primary");
  });

  it("throws on empty or non-string filePath", () => {
    assert.throws(() => resolveMemberFromPath(WORKSPACE_CFG, ""), /non-empty string/);
    assert.throws(() => resolveMemberFromPath(WORKSPACE_CFG, null), /non-empty string/);
  });

  // PR 8 R1 (Copilot): empty-after-normalisation inputs like "./" and
  // "////" previously produced fileParts = [""] and silently resolved
  // to the root member. Now rejected at the normaliser.
  it("throws on inputs that collapse to empty after normalisation", () => {
    assert.throws(() => resolveMemberFromPath(WORKSPACE_CFG, "./"), /collapses to empty/);
    assert.throws(() => resolveMemberFromPath(WORKSPACE_CFG, "////"), /absolute/); // leading '/' now caught explicitly
  });

  // PR 8 R1 (Copilot): Windows backslashes in either filePath or
  // member.path previously never matched POSIX diff input.
  it("normalises backslashes in filePath so Windows-style input matches POSIX member paths", () => {
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "libs\\shared\\x.ts"), "shared");
  });

  it("normalises backslashes in member.path so a Windows-style config matches POSIX diff input", () => {
    const winCfg = {
      workspace: {
        members: [
          {
            path: "libs\\shared",
            name: "shared",
            trackers: { dev: { kind: "github", owner: "acme", repo: "s", projects: [] } },
          },
        ],
      },
    };
    assert.equal(resolveMemberFromPath(winCfg, "libs/shared/x.ts"), "shared");
  });
});

describe("normaliseMemberPath: the canonical path normaliser", () => {
  it("strips leading './' and trailing '/'", () => {
    assert.equal(normaliseMemberPath("./libs/shared/", "x"), "libs/shared");
    assert.equal(normaliseMemberPath("libs/shared", "x"), "libs/shared");
  });

  it("converts backslashes to forward slashes", () => {
    assert.equal(normaliseMemberPath("libs\\shared", "x"), "libs/shared");
    assert.equal(normaliseMemberPath(".\\libs\\shared\\", "x"), "libs/shared");
  });

  it("rejects absolute paths", () => {
    assert.throws(() => normaliseMemberPath("/absolute", "x"), /absolute/);
    assert.throws(() => normaliseMemberPath("/foo/bar", "x"), /absolute/);
  });

  it("rejects Windows drive paths", () => {
    assert.throws(() => normaliseMemberPath("C:\\foo", "x"), /drive/);
    assert.throws(() => normaliseMemberPath("D:/bar", "x"), /drive/);
  });

  // PR 8 R8 (Copilot): drive-relative form `C:foo` (no separator
  // after the colon) is still drive-qualified on Windows and must
  // also be rejected; the earlier guard only matched `[A-Za-z]:[\\/]`.
  it("rejects Windows drive-relative paths (no separator after colon)", () => {
    assert.throws(() => normaliseMemberPath("C:foo", "x"), /drive/);
    assert.throws(() => normaliseMemberPath("Z:bar/baz", "x"), /drive/);
  });

  it("rejects '..' segments", () => {
    assert.throws(() => normaliseMemberPath("../escape", "x"), /'\.\.'/);
    assert.throws(() => normaliseMemberPath("libs/../escape", "x"), /'\.\.'/);
  });

  it("rejects empty string and non-string", () => {
    assert.throws(() => normaliseMemberPath("", "x"), /non-empty/);
    assert.throws(() => normaliseMemberPath(null, "x"), /non-empty/);
    assert.throws(() => normaliseMemberPath(42, "x"), /non-empty/);
  });

  it("rejects collapse-to-empty without allowRoot", () => {
    assert.throws(() => normaliseMemberPath(".", "x"), /collapses to empty/);
    assert.throws(() => normaliseMemberPath("./", "x"), /collapses to empty/);
  });

  it("returns '.' for collapse-to-empty WITH allowRoot (member root convention)", () => {
    assert.equal(normaliseMemberPath(".", "x", { allowRoot: true }), ".");
    assert.equal(normaliseMemberPath("./", "x", { allowRoot: true }), ".");
  });

  it("includes the label in every error message for debuggability", () => {
    try {
      normaliseMemberPath("/absolute", "member 'shared' path");
      assert.fail("expected throw");
    } catch (e) {
      assert.match(e.message, /member 'shared' path/);
    }
  });

  // PR 8 R2 (Copilot): consecutive separators ("libs//shared") and
  // interior "." segments ("libs/./shared") were accepted verbatim,
  // but real git-diff paths never contain them. A member.path like
  // "libs//shared" would then never match "libs/shared/x.ts" at
  // runtime. Canonicalise to a single "/" with no "." segments.
  it("collapses consecutive slashes to a single separator", () => {
    assert.equal(normaliseMemberPath("libs//shared", "x"), "libs/shared");
    assert.equal(normaliseMemberPath("libs///shared///x", "x"), "libs/shared/x");
  });

  it("drops interior '.' segments", () => {
    assert.equal(normaliseMemberPath("libs/./shared", "x"), "libs/shared");
    assert.equal(normaliseMemberPath("a/./b/./c", "x"), "a/b/c");
  });

  it("normalises mixed backslash+double-slash+'.' inputs", () => {
    assert.equal(normaliseMemberPath("libs\\\\shared/./x", "x"), "libs/shared/x");
  });

  it("treats './././' as a rootOnly collapse (allowRoot only)", () => {
    assert.equal(normaliseMemberPath("././", "x", { allowRoot: true }), ".");
    assert.throws(() => normaliseMemberPath("././", "x"), /collapses to empty/);
  });

  // Regression: now that the normaliser collapses '//' and '.'
  // segments, resolveMemberFromPath should transparently accept
  // caller inputs with those artefacts and still resolve correctly.
  it("resolveMemberFromPath accepts inputs with '//' and '.' segments", () => {
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "libs//shared/x.ts"), "shared");
    assert.equal(resolveMemberFromPath(WORKSPACE_CFG, "libs/./shared/x.ts"), "shared");
  });
});
