// review_dispatcher.test.mjs
// Unit tests for the ReviewProvider dispatcher. Dispatches to the GitHub
// impl when trackers.dev.kind is "github" (new shape) OR when the legacy
// top-level `github:` block is present (transitional shim for PR 2 that
// PR 3's multi-tracker refactor will remove). Every other kind returns
// the stub.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickReviewProvider,
  resolveTrackerKind,
} from "../scripts/lib/review/dispatcher.mjs";
import {
  NotSupportedError,
  REVIEW_PROVIDER_METHODS,
} from "../scripts/lib/review/provider.mjs";

describe("resolveTrackerKind", () => {
  it("returns trackers.dev.kind when present (new shape)", () => {
    assert.equal(resolveTrackerKind({ trackers: { dev: { kind: "github" } } }), "github");
    assert.equal(resolveTrackerKind({ trackers: { dev: { kind: "Jira" } } }), "jira");
  });
  it("falls back to 'github' when only the legacy top-level github block is present", () => {
    assert.equal(resolveTrackerKind({ github: { auth_login: "alice" } }), "github");
  });
  it("prefers the new shape over the legacy one when both exist", () => {
    const cfg = {
      trackers: { dev: { kind: "linear" } },
      github: { auth_login: "alice" },
    };
    assert.equal(resolveTrackerKind(cfg), "linear");
  });
  it("returns 'unknown' when neither shape is present", () => {
    assert.equal(resolveTrackerKind({}), "unknown");
    assert.equal(resolveTrackerKind({ project: {} }), "unknown");
    assert.equal(resolveTrackerKind(null), "unknown");
  });
  it("lowercases the kind so downstream comparisons are deterministic", () => {
    assert.equal(resolveTrackerKind({ trackers: { dev: { kind: "GITHUB" } } }), "github");
  });
});

describe("pickReviewProvider", () => {
  it("returns the GitHub impl when kind === 'github'", () => {
    const { provider, kind } = pickReviewProvider({ trackers: { dev: { kind: "github" } } });
    assert.equal(kind, "github");
    // github impl has all five methods wired
    for (const op of REVIEW_PROVIDER_METHODS) {
      assert.equal(typeof provider[op], "function", `github provider missing ${op}`);
    }
  });

  it("returns a stub for jira (NotSupportedError on every op)", () => {
    const { provider, kind } = pickReviewProvider({ trackers: { dev: { kind: "jira" } } });
    assert.equal(kind, "jira");
    assert.throws(() => provider.requestReview({}), (err) => {
      return err instanceof NotSupportedError && err.kind === "jira";
    });
  });

  it("returns a stub for linear and gitlab (PR 3 will swap these for real impls)", () => {
    for (const k of ["linear", "gitlab"]) {
      const { provider, kind } = pickReviewProvider({ trackers: { dev: { kind: k } } });
      assert.equal(kind, k);
      assert.throws(() => provider.pollForReview({}), NotSupportedError);
    }
  });

  it("treats legacy github: config as kind=github (transitional shim)", () => {
    const { provider, kind } = pickReviewProvider({ github: { auth_login: "alice" } });
    assert.equal(kind, "github");
    // The GitHub impl, not the stub; methods exist and do NOT throw
    // NotSupportedError on mere presence. (Calling them without gh on
    // PATH would throw a different error; here we just verify the
    // dispatcher routed to the right module.)
    assert.equal(typeof provider.requestReview, "function");
  });

  it("returns a stub with kind='unknown' when nothing is configured", () => {
    const { provider, kind } = pickReviewProvider({});
    assert.equal(kind, "unknown");
    assert.throws(() => provider.ciStateOnHead({}), (err) => {
      return err instanceof NotSupportedError && err.kind === "unknown";
    });
  });
});
