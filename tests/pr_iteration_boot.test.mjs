import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPendingPrStates,
  writePrState,
  markPrStateStopped,
  markPrStatePaused,
} from "../scripts/lib/pr-iteration/state.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pr-iter-boot-"));
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

describe("listPendingPrStates (boot context)", () => {
  it("returns empty array cleanly when directory does not exist", async () => {
    const result = await listPendingPrStates(join(scratch, "does-not-exist"));
    assert.deepEqual(result, []);
  });

  it("returns empty array when directory exists but is empty", async () => {
    const dir = join(scratch, "empty-dir");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const result = await listPendingPrStates(dir);
    assert.deepEqual(result, []);
  });

  it("enumerates multiple pending PRs", async () => {
    const dir = join(scratch, "multi");
    await writePrState(dir, makeState({ prId: "org/a#1", owner: "org", repo: "a", prNumber: 1 }));
    await writePrState(dir, makeState({ prId: "org/b#2", owner: "org", repo: "b", prNumber: 2 }));
    await writePrState(dir, makeState({ prId: "org/c#3", owner: "org", repo: "c", prNumber: 3 }));

    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((r) => r.prId),
      ["org/a#1", "org/b#2", "org/c#3"],
    );
  });

  it("skips PRs with .stopped sidecar", async () => {
    const dir = join(scratch, "skip-stopped");
    await writePrState(dir, makeState({ prId: "org/x#10", owner: "org", repo: "x", prNumber: 10 }));
    await writePrState(dir, makeState({ prId: "org/x#11", owner: "org", repo: "x", prNumber: 11 }));
    await markPrStateStopped(dir, "org/x#10", "user cancelled");

    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].prId, "org/x#11");
  });

  it("skips PRs with .paused sidecar", async () => {
    const dir = join(scratch, "skip-paused");
    await writePrState(dir, makeState({ prId: "org/y#20", owner: "org", repo: "y", prNumber: 20 }));
    await writePrState(dir, makeState({ prId: "org/y#21", owner: "org", repo: "y", prNumber: 21 }));
    await markPrStatePaused(dir, "org/y#20", "safety cap");

    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].prId, "org/y#21");
  });

  it("each returned entry includes the full state object", async () => {
    const dir = join(scratch, "full-state");
    await writePrState(dir, makeState({ prId: "org/z#5", owner: "org", repo: "z", prNumber: 5, lastRound: 3 }));

    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].state.lastRound, 3);
    assert.equal(result[0].state.prNodeId, "PR_kwDOtest");
  });
});
