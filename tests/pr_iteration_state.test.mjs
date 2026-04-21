import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readPrState,
  writePrState,
  listPendingPrStates,
  markPrStateStopped,
  markPrStatePaused,
  isStateStopped,
  isStatePaused,
  removePrState,
  stateFileName,
} from "../scripts/lib/pr-iteration/state.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pr-iter-state-"));
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

describe("stateFileName", () => {
  it("derives filename from prId", () => {
    assert.equal(stateFileName("acme/repo#42"), "acme__repo__42.json");
  });

  it("handles dotted owner and repo names", () => {
    assert.equal(stateFileName("my.org/my.repo#7"), "my.org__my.repo__7.json");
  });

  it("throws on invalid prId", () => {
    assert.throws(() => stateFileName("bad-format"), /Invalid prId format/);
    assert.throws(() => stateFileName(""), /Invalid prId format/);
  });
});

describe("readPrState + writePrState round-trip", () => {
  it("writes then reads back an identical state object", async () => {
    const dir = join(scratch, "roundtrip");
    const state = makeState();
    await writePrState(dir, state);
    const read = await readPrState(dir, "acme/repo#42");
    assert.equal(read.prId, "acme/repo#42");
    assert.equal(read.prNumber, 42);
    assert.equal(read.intervalSeconds, 270);
    // updatedAt is refreshed on write
    assert.ok(read.updatedAt);
  });

  it("returns null for a missing state file", async () => {
    const dir = join(scratch, "missing");
    assert.equal(await readPrState(dir, "no/such#1"), null);
  });

  it("throws on schema validation failure", async () => {
    const dir = join(scratch, "bad-schema");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "bad__data__1.json"),
      JSON.stringify({ prId: "bad/data#1", broken: true }),
    );
    await assert.rejects(
      () => readPrState(dir, "bad/data#1"),
      /failed schema validation/,
    );
  });

  it("atomic write leaves no tmp file behind", async () => {
    const dir = join(scratch, "atomic-clean");
    await writePrState(dir, makeState());
    const entries = await readdir(dir);
    assert.ok(entries.every((e) => !e.includes(".tmp-")));
  });
});

describe("listPendingPrStates", () => {
  it("returns empty array when directory does not exist", async () => {
    const result = await listPendingPrStates(join(scratch, "nonexistent"));
    assert.deepEqual(result, []);
  });

  it("lists states in deterministic (sorted) order", async () => {
    const dir = join(scratch, "list-sorted");
    await writePrState(dir, makeState({ prId: "z/repo#2", owner: "z", repo: "repo", prNumber: 2 }));
    await writePrState(dir, makeState({ prId: "a/repo#1", owner: "a", repo: "repo", prNumber: 1 }));
    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 2);
    assert.equal(result[0].prId, "a/repo#1");
    assert.equal(result[1].prId, "z/repo#2");
  });

  it("excludes stopped states", async () => {
    const dir = join(scratch, "list-stopped");
    await writePrState(dir, makeState({ prId: "org/r#10", owner: "org", repo: "r", prNumber: 10 }));
    await markPrStateStopped(dir, "org/r#10", "test");
    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 0);
  });

  it("excludes paused states", async () => {
    const dir = join(scratch, "list-paused");
    await writePrState(dir, makeState({ prId: "org/r#11", owner: "org", repo: "r", prNumber: 11 }));
    await markPrStatePaused(dir, "org/r#11", "cap");
    const result = await listPendingPrStates(dir);
    assert.equal(result.length, 0);
  });
});

describe("markPrStateStopped + isStateStopped", () => {
  it("writes a .stopped sidecar with reason", async () => {
    const dir = join(scratch, "stopped-sidecar");
    await writePrState(dir, makeState());
    await markPrStateStopped(dir, "acme/repo#42", "user cancelled");
    assert.ok(await isStateStopped(dir, "acme/repo#42"));
    const content = JSON.parse(
      await readFile(join(dir, "acme__repo__42.stopped"), "utf8"),
    );
    assert.equal(content.reason, "user cancelled");
    assert.ok(content.stoppedAt);
  });

  it("isStateStopped returns false when no sidecar", async () => {
    const dir = join(scratch, "no-stopped");
    assert.equal(await isStateStopped(dir, "x/y#1"), false);
  });
});

describe("markPrStatePaused + isStatePaused", () => {
  it("writes a .paused sidecar with reason", async () => {
    const dir = join(scratch, "paused-sidecar");
    await writePrState(dir, makeState());
    await markPrStatePaused(dir, "acme/repo#42", "safety cap");
    assert.ok(await isStatePaused(dir, "acme/repo#42"));
    const content = JSON.parse(
      await readFile(join(dir, "acme__repo__42.paused"), "utf8"),
    );
    assert.equal(content.reason, "safety cap");
  });
});

describe("removePrState", () => {
  it("deletes the state file", async () => {
    const dir = join(scratch, "remove");
    await writePrState(dir, makeState());
    await removePrState(dir, "acme/repo#42");
    assert.equal(await readPrState(dir, "acme/repo#42"), null);
  });

  it("is a no-op when the file is already gone", async () => {
    const dir = join(scratch, "remove-missing");
    await assert.doesNotReject(() => removePrState(dir, "no/such#99"));
  });
});
