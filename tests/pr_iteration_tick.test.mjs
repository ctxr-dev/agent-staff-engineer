import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTick } from "../scripts/lib/pr-iteration/tick.mjs";
import {
  writePrState,
  readPrState,
  markPrStateStopped,
  markPrStatePaused,
  isStatePaused,
} from "../scripts/lib/pr-iteration/state.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pr-iter-tick-"));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function makeState(overrides = {}) {
  return {
    prId: "acme/repo#42",
    owner: "acme",
    repo: "repo",
    prNumber: 42,
    memberName: null,
    prNodeId: "PR_kwDOtest",
    botIds: ["BOT_abc"],
    botLogins: ["copilot-pull-request-reviewer"],
    headSha: "abc1234",
    lastRound: 0,
    nextWakeAt: null,
    intervalSeconds: 270,
    consecutiveWakes: 0,
    lastPollResult: {
      ciState: "PENDING",
      unresolvedCount: 0,
      reviewOnHead: false,
      observedAt: "2026-04-21T12:00:00.000Z",
    },
    exitConditions: {
      localReviewGo: true,
      zeroUnresolvedOnHead: false,
      ciSuccessOnHead: false,
    },
    createdAt: "2026-04-21T12:00:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  };
}

function fakeTracker(pollResult) {
  return {
    review: {
      pollForReview: async () => pollResult,
    },
  };
}

describe("runTick: user-cancelled", () => {
  it("returns done + user-cancelled when .stopped sidecar exists", async () => {
    const dir = join(scratch, "cancelled");
    const state = makeState();
    await writePrState(dir, state);
    await markPrStateStopped(dir, state.prId, "test");

    const tracker = fakeTracker({ ciState: "SUCCESS", unresolvedCount: 0, reviewOnHead: true });
    const result = await runTick(tracker, state, { stateDir: dir });

    assert.equal(result.done, true);
    assert.equal(result.action, "user-cancelled");
  });
});

describe("runTick: paused", () => {
  it("returns done + paused when .paused sidecar exists (no remote call)", async () => {
    const dir = join(scratch, "paused-gate");
    const state = makeState();
    await writePrState(dir, state);
    await markPrStatePaused(dir, state.prId, "safety cap");

    let pollCalled = false;
    const tracker = {
      review: {
        pollForReview: async () => { pollCalled = true; return {}; },
      },
    };
    const result = await runTick(tracker, state, { stateDir: dir });

    assert.equal(result.done, true);
    assert.equal(result.action, "paused");
    assert.equal(pollCalled, false, "should not call pollForReview when paused");
  });
});

describe("runTick: complete", () => {
  it("returns done + complete when all exit conditions hold", async () => {
    const dir = join(scratch, "complete");
    const state = makeState({ exitConditions: { localReviewGo: true, zeroUnresolvedOnHead: false, ciSuccessOnHead: false } });
    await writePrState(dir, state);

    const tracker = fakeTracker({ ciState: "SUCCESS", unresolvedCount: 0, reviewOnHead: true });
    const result = await runTick(tracker, state, { stateDir: dir });

    assert.equal(result.done, true);
    assert.equal(result.action, "complete");
    assert.equal(result.state.exitConditions.ciSuccessOnHead, true);
    assert.equal(result.state.exitConditions.zeroUnresolvedOnHead, true);
    // State file should be removed
    assert.equal(await readPrState(dir, state.prId), null);
  });
});

describe("runTick: still-waiting", () => {
  it("returns not-done + still-waiting when CI is PENDING and no activity", async () => {
    const dir = join(scratch, "waiting");
    const state = makeState();
    await writePrState(dir, state);

    const tracker = fakeTracker({ ciState: "PENDING", unresolvedCount: 0, reviewOnHead: false });
    const result = await runTick(tracker, state, { stateDir: dir });

    assert.equal(result.done, false);
    assert.equal(result.action, "still-waiting");
    assert.equal(result.state.consecutiveWakes, 1);
    // State should be persisted
    const persisted = await readPrState(dir, state.prId);
    assert.equal(persisted.consecutiveWakes, 1);
  });
});

describe("runTick: needs-triage", () => {
  it("returns not-done + needs-triage when CI terminal + threads exist", async () => {
    const dir = join(scratch, "triage-threads");
    const state = makeState({ consecutiveWakes: 5 });
    await writePrState(dir, state);

    const tracker = fakeTracker({ ciState: "SUCCESS", unresolvedCount: 3, reviewOnHead: true });
    const result = await runTick(tracker, state, { stateDir: dir });

    assert.equal(result.done, false);
    assert.equal(result.action, "needs-triage");
    assert.equal(result.state.consecutiveWakes, 0, "resets on forward progress");
    assert.equal(result.state.lastPollResult.unresolvedCount, 3);
  });

  it("returns needs-triage when CI SUCCESS + review on HEAD (zero threads)", async () => {
    const dir = join(scratch, "triage-review");
    const state = makeState();
    await writePrState(dir, state);

    // Review on HEAD with 0 threads is still "needs-triage" because the
    // skill must verify all conditions before declaring complete
    // (localReviewGo may be false after a code change)
    const tracker = fakeTracker({ ciState: "SUCCESS", unresolvedCount: 0, reviewOnHead: true });
    // localReviewGo is false so it won't be "complete"
    state.exitConditions.localReviewGo = false;
    const result = await runTick(tracker, state, { stateDir: dir });

    // CI terminal + reviewOnHead = needs-triage (even if 0 threads)
    assert.equal(result.done, false);
    assert.equal(result.action, "needs-triage");
  });

  it("returns needs-triage when CI FAILURE (regardless of threads)", async () => {
    const dir = join(scratch, "triage-ci-fail");
    const state = makeState();
    await writePrState(dir, state);

    const tracker = fakeTracker({ ciState: "FAILURE", unresolvedCount: 0, reviewOnHead: true });
    const result = await runTick(tracker, state, { stateDir: dir });

    assert.equal(result.done, false);
    assert.equal(result.action, "needs-triage");
  });
});

describe("runTick: safety-cap", () => {
  it("returns done + safety-cap when max consecutive wakes reached", async () => {
    const dir = join(scratch, "safety-cap");
    const state = makeState({ consecutiveWakes: 2 });
    await writePrState(dir, state);

    const tracker = fakeTracker({ ciState: "PENDING", unresolvedCount: 0, reviewOnHead: false });
    const result = await runTick(tracker, state, { stateDir: dir, maxConsecutiveWakes: 3 });

    assert.equal(result.done, true);
    assert.equal(result.action, "safety-cap");
    assert.equal(result.state.consecutiveWakes, 3);
    assert.ok(await isStatePaused(dir, state.prId));
  });
});

describe("runTick: lastPollResult is always updated", () => {
  it("persists the poll result in state even when still-waiting", async () => {
    const dir = join(scratch, "poll-persist");
    const state = makeState();
    await writePrState(dir, state);

    const tracker = fakeTracker({ ciState: "PENDING", unresolvedCount: 0, reviewOnHead: false });
    await runTick(tracker, state, { stateDir: dir });

    const persisted = await readPrState(dir, state.prId);
    assert.equal(persisted.lastPollResult.ciState, "PENDING");
    assert.ok(persisted.lastPollResult.observedAt);
  });
});
