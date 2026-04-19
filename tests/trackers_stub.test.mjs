// trackers_stub.test.mjs
// Unit tests for the shared stub Tracker. Every namespace method must
// throw NotSupportedError with a consistent shape (.kind, .op,
// .namespace; message includes kind and fully-qualified op), so
// callers can catch by instanceof and surface a clean "not supported"
// message without type-sniffing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotSupportedError,
  REVIEW_METHODS,
  TRACKER_NAMESPACES,
} from "../scripts/lib/trackers/tracker.mjs";
import { makeStubTracker } from "../scripts/lib/trackers/stub.mjs";

describe("stub tracker: review methods reject with NotSupportedError (async)", () => {
  for (const op of REVIEW_METHODS) {
    it(`review.${op} rejects with kind + op + namespace populated`, async () => {
      const tracker = makeStubTracker("jira");
      assert.equal(typeof tracker.review[op], "function");
      await assert.rejects(
        () => tracker.review[op]({}, "arg1", "arg2"),
        (err) => {
          assert.ok(
            err instanceof NotSupportedError,
            `expected NotSupportedError, got ${err?.constructor?.name}`,
          );
          assert.equal(err.kind, "jira");
          assert.equal(err.op, op);
          assert.equal(err.namespace, "review");
          assert.match(err.message, /does not implement/);
          assert.match(
            err.message,
            new RegExp(`'review\\.${op}'`),
            `message should name the fully-qualified op 'review.${op}'`,
          );
          assert.match(err.message, /jira/);
          return true;
        },
      );
    });
  }
});

describe("stub tracker: every declared namespace throws on every method", () => {
  it("covers every entry in TRACKER_NAMESPACES", async () => {
    const tracker = makeStubTracker("linear");
    for (const [namespace, methods] of Object.entries(TRACKER_NAMESPACES)) {
      assert.ok(tracker[namespace], `stub tracker missing namespace '${namespace}'`);
      for (const op of methods) {
        assert.equal(
          typeof tracker[namespace][op],
          "function",
          `stub tracker missing method '${namespace}.${op}'`,
        );
        await assert.rejects(
          () => tracker[namespace][op]({}),
          (err) =>
            err instanceof NotSupportedError &&
            err.kind === "linear" &&
            err.op === op &&
            err.namespace === namespace,
          `${namespace}.${op} should reject with a tagged NotSupportedError`,
        );
      }
    }
  });
});

describe("stub tracker: kind flows through to the error", () => {
  it("preserves arbitrary kinds", async () => {
    for (const kind of ["linear", "gitlab", "jira", "none"]) {
      const tracker = makeStubTracker(kind);
      await assert.rejects(
        () => tracker.review.requestReview({}),
        (err) => {
          assert.equal(err.kind, kind);
          assert.match(err.message, new RegExp(`'${kind}'`));
          return true;
        },
      );
    }
  });

  it("review methods return Promises (interchangeable with real provider)", () => {
    const tracker = makeStubTracker("jira");
    for (const op of REVIEW_METHODS) {
      const p = tracker.review[op]({});
      assert.ok(p && typeof p.then === "function", `${op} must return a Promise`);
      p.catch(() => {}); // swallow; rejection content is asserted above
    }
  });

  it("refuses an empty or non-string kind at construction time", () => {
    assert.throws(() => makeStubTracker(""), /non-empty string/);
    assert.throws(() => makeStubTracker(null), /non-empty string/);
    assert.throws(() => makeStubTracker(undefined), /non-empty string/);
    assert.throws(() => makeStubTracker(42), /non-empty string/);
  });
});

describe("stub tracker: passes through `target` verbatim (shape parity with real impls)", () => {
  it("stores the supplied target on the returned tracker", () => {
    const target = { kind: "jira", site: "acme.atlassian.net", project: "PLAT" };
    const tracker = makeStubTracker("jira", target);
    assert.strictEqual(tracker.target, target);
    assert.equal(tracker.kind, "jira");
  });

  it("defaults target to {} when not supplied", () => {
    const tracker = makeStubTracker("linear");
    assert.deepEqual(tracker.target, {});
  });
});
