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
