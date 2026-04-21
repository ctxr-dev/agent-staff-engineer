import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeSession,
  readSession,
  listPendingSessions,
  archiveSession,
  sessionDirFor,
} from "../scripts/lib/sessionState.mjs";

const scratch = await mkdtemp(join(tmpdir(), "session-state-"));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("sessionState.writeSession / readSession", () => {
  it("writes atomically under .development/local/<domain>/ and reads back the same object", async () => {
    const state = {
      sessionId: "20260421-120000-abcd",
      version: 1,
      startedAt: "2026-04-21T12:00:00Z",
      whatever: "extra",
    };
    await writeSession(scratch, "test-domain", "20260421-120000-abcd", state);
    const roundTripped = await readSession(scratch, "test-domain", "20260421-120000-abcd");
    assert.deepEqual(roundTripped, state);
    const dir = sessionDirFor(scratch, "test-domain");
    assert.ok(dir.endsWith(join(".development", "local", "test-domain")));
  });

  it("returns null for a missing session file", async () => {
    const state = await readSession(scratch, "test-domain", "nonexistent");
    assert.equal(state, null);
  });

  it("rejects an invalid domain (must be kebab-case ASCII)", async () => {
    await assert.rejects(
      () => writeSession(scratch, "Bad Domain!", "abc", {}),
      /domain must be kebab-case/,
    );
  });

  it("rejects an invalid sessionId (fs-safe allow-list only)", async () => {
    await assert.rejects(
      () => writeSession(scratch, "dom", "../escape", {}),
      /sessionId must match/,
    );
  });

  it("rejects a non-object state", async () => {
    await assert.rejects(
      () => writeSession(scratch, "dom", "abc", "not an object"),
      /state must be a plain object/,
    );
  });
});

describe("sessionState.listPendingSessions", () => {
  it("enumerates non-archived files in the domain directory", async () => {
    // Generate timestamps relative to the wall clock so the test
    // doesn't regress the moment CI clock drifts or a future run
    // precedes the hardcoded date. `s1` is 24h older than `s2`.
    const older = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const newer = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const s1 = { sessionId: "20260420-100000-aaaa", version: 1, startedAt: older };
    const s2 = { sessionId: "20260421-110000-bbbb", version: 1, startedAt: newer };
    await writeSession(scratch, "list-test", "20260420-100000-aaaa", s1);
    await writeSession(scratch, "list-test", "20260421-110000-bbbb", s2);

    const pending = await listPendingSessions(scratch, "list-test");
    const ids = pending.map((e) => e.sessionId).sort();
    assert.deepEqual(ids, ["20260420-100000-aaaa", "20260421-110000-bbbb"]);
    // oldest first (larger ageMs) per the helper's documented contract.
    assert.ok(pending[0].ageMs >= pending[1].ageMs, "pending should be sorted oldest-first");
  });

  it("returns an empty array when the domain directory does not exist", async () => {
    const result = await listPendingSessions(scratch, "never-created");
    assert.deepEqual(result, []);
  });

  it("skips archived files (<sessionId>.<outcome>.json)", async () => {
    const s = { sessionId: "20260422-120000-cccc", version: 1, startedAt: "2026-04-22T12:00:00Z" };
    await writeSession(scratch, "archive-test", "20260422-120000-cccc", s);
    await archiveSession(scratch, "archive-test", "20260422-120000-cccc", "completed");
    const pending = await listPendingSessions(scratch, "archive-test");
    assert.deepEqual(pending, []);
  });

  it("surfaces malformed JSON without dropping the entry silently", async () => {
    const dir = sessionDirFor(scratch, "malformed-test");
    await writeSession(scratch, "malformed-test", "20260423-130000-dddd", {
      sessionId: "20260423-130000-dddd",
      version: 1,
      startedAt: "2026-04-23T13:00:00Z",
    });
    // overwrite the real file with garbage
    const entries = await readdir(dir);
    const target = entries.find((f) => f.startsWith("20260423"));
    await writeFile(join(dir, target), "{not json", "utf8");
    const pending = await listPendingSessions(scratch, "malformed-test");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, null);
    assert.ok(typeof pending[0].error === "string" && pending[0].error.length > 0);
  });
});

describe("sessionState.archiveSession", () => {
  it("renames the file to <sessionId>.<outcome>.json", async () => {
    const s = { sessionId: "20260424-140000-eeee", version: 1, startedAt: "2026-04-24T14:00:00Z" };
    await writeSession(scratch, "rename-test", "20260424-140000-eeee", s);
    const newPath = await archiveSession(scratch, "rename-test", "20260424-140000-eeee", "completed");
    assert.ok(newPath.endsWith("20260424-140000-eeee.completed.json"));
    const roundTripped = JSON.parse(await readFile(newPath, "utf8"));
    assert.deepEqual(roundTripped, s);
  });

  it("returns null when the source file does not exist (idempotent)", async () => {
    const result = await archiveSession(scratch, "rename-test", "nope", "completed");
    assert.equal(result, null);
  });

  it("rejects an outcome that doesn't match the allow-list", async () => {
    const s = { sessionId: "20260425-150000-ffff", version: 1, startedAt: "2026-04-25T15:00:00Z" };
    await writeSession(scratch, "outcome-test", "20260425-150000-ffff", s);
    await assert.rejects(
      () => archiveSession(scratch, "outcome-test", "20260425-150000-ffff", "Bad Outcome"),
      /outcome must match/,
    );
  });
});
