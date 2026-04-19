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

describe("review/stub: every method rejects with NotSupportedError (async)", () => {
  for (const op of REVIEW_PROVIDER_METHODS) {
    it(`${op} rejects with kind + op populated`, async () => {
      // Stub methods MUST be async so the contract matches the real
      // GitHub provider (which returns Promises). assert.rejects
      // requires await so the promise settlement is observed.
      const provider = makeStubProvider("jira");
      assert.equal(typeof provider[op], "function");
      await assert.rejects(
        () => provider[op]({}, "arg1", "arg2"),
        (err) => {
          assert.ok(err instanceof NotSupportedError, `expected NotSupportedError, got ${err?.constructor?.name}`);
          assert.equal(err.kind, "jira");
          assert.equal(err.op, op);
          assert.match(err.message, /pr-iteration review op/);
          assert.match(err.message, new RegExp(`'${op}'`), `message should name the op '${op}'`);
          assert.match(err.message, /jira/);
          return true;
        },
      );
    });
  }
});

describe("review/stub: kind flows through to the error", () => {
  it("preserves arbitrary kinds (linear, gitlab, anything)", async () => {
    for (const kind of ["linear", "gitlab", "unknown"]) {
      const provider = makeStubProvider(kind);
      await assert.rejects(
        () => provider.requestReview({}),
        (err) => {
          assert.equal(err.kind, kind);
          assert.match(err.message, new RegExp(`'${kind}'`));
          return true;
        },
      );
    }
  });

  it("stub methods return promises (interchangeable with real provider)", () => {
    const provider = makeStubProvider("jira");
    for (const op of REVIEW_PROVIDER_METHODS) {
      // Each invocation must return a thenable (Promise). We catch
      // to silence the unhandled rejection.
      const p = provider[op]({});
      assert.ok(p && typeof p.then === "function", `${op} must return a Promise`);
      p.catch(() => {}); // swallow; the rejection-content is asserted above
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
