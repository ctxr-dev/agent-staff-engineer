import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeInterval,
  buildWakeupPrompt,
  buildWakeupReason,
} from "../scripts/lib/pr-iteration/reschedule.mjs";

describe("computeInterval", () => {
  it("returns 270 when no overrides are given", () => {
    assert.equal(computeInterval(undefined, undefined, undefined), 270);
  });

  it("honours explicit user override", () => {
    assert.equal(computeInterval(600, { intervalSeconds: 270 }, 270), 600);
  });

  it("falls back to state.intervalSeconds when no user override", () => {
    assert.equal(computeInterval(null, { intervalSeconds: 180 }, 270), 180);
  });

  it("falls back to configDefault when no user override and no state", () => {
    assert.equal(computeInterval(null, null, 300), 300);
  });

  it("clamps below minimum (60s)", () => {
    assert.equal(computeInterval(10, null, null), 60);
  });

  it("clamps above maximum (3600s)", () => {
    assert.equal(computeInterval(5000, null, null), 3600);
  });

  it("clamps configDefault too", () => {
    assert.equal(computeInterval(null, null, 10), 60);
  });
});

describe("buildWakeupPrompt", () => {
  it("returns /resume-pr-iteration with the prId", () => {
    const prompt = buildWakeupPrompt({ prId: "acme/repo#42" });
    assert.equal(prompt, "/resume-pr-iteration acme/repo#42");
  });
});

describe("buildWakeupReason", () => {
  it("includes CI state and unresolved count", () => {
    const reason = buildWakeupReason({
      prId: "acme/repo#42",
      lastPollResult: { ciState: "PENDING", unresolvedCount: 3 },
    });
    assert.match(reason, /acme\/repo#42/);
    assert.match(reason, /PENDING/);
    assert.match(reason, /3/);
  });

  it("handles missing lastPollResult gracefully", () => {
    const reason = buildWakeupReason({ prId: "x/y#1" });
    assert.match(reason, /x\/y#1/);
    assert.match(reason, /unknown/);
  });
});
