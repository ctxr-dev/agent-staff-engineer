// review_stub.test.mjs
// Unit tests for the ReviewProvider stub. Every method must throw
// NotSupportedError with a consistent shape (.kind, .op, message includes
// kind and names the unsupported op, caller can catch by instanceof).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotSupportedError,
  REVIEW_PROVIDER_METHODS,
} from "../scripts/lib/review/provider.mjs";
import { makeStubProvider } from "../scripts/lib/review/stub.mjs";

describe("review/stub: every method throws NotSupportedError", () => {
  for (const op of REVIEW_PROVIDER_METHODS) {
    it(`${op} throws with kind + op populated`, () => {
      const provider = makeStubProvider("jira");
      assert.equal(typeof provider[op], "function");
      try {
        provider[op]({}, "arg1", "arg2");
        assert.fail(`${op} should have thrown`);
      } catch (err) {
        assert.ok(err instanceof NotSupportedError, `expected NotSupportedError, got ${err.constructor.name}`);
        assert.equal(err.kind, "jira");
        assert.equal(err.op, op);
        assert.match(err.message, /pr-iteration review loop is not implemented/);
        assert.match(err.message, /jira/);
      }
    });
  }
});

describe("review/stub: kind flows through to the error", () => {
  it("preserves arbitrary kinds (linear, gitlab, anything)", () => {
    for (const kind of ["linear", "gitlab", "unknown"]) {
      const provider = makeStubProvider(kind);
      try {
        provider.requestReview({});
        assert.fail("should throw");
      } catch (err) {
        assert.equal(err.kind, kind);
        assert.match(err.message, new RegExp(`'${kind}'`));
      }
    }
  });
});

describe("review/stub: coverage vs REVIEW_PROVIDER_METHODS", () => {
  it("exposes a function for every method name in the canonical list", () => {
    const provider = makeStubProvider("jira");
    for (const op of REVIEW_PROVIDER_METHODS) {
      assert.equal(
        typeof provider[op],
        "function",
        `stub missing method '${op}' declared in REVIEW_PROVIDER_METHODS`,
      );
    }
  });
});
