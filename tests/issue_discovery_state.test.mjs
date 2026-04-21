import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  newSessionId,
  slugFromIntent,
  readSession,
  writeSession,
  listPendingSessions,
  archiveSession,
  DOMAIN_NAME,
} from "../scripts/lib/issueDiscovery.mjs";
import { readJsonOrNull } from "../scripts/lib/fsx.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_SCHEMA = await readJsonOrNull(
  join(__dirname, "..", "schemas", "issue-discovery-session.schema.json"),
);
if (!SESSION_SCHEMA) throw new Error("issue-discovery-session.schema.json missing");

const scratch = await mkdtemp(join(tmpdir(), "issue-discovery-state-"));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function makeValidState(sessionId, overrides = {}) {
  const base = {
    sessionId,
    version: 1,
    startedAt: "2026-04-21T12:00:00Z",
    updatedAt: "2026-04-21T12:00:00Z",
    currentStep: "q0",
    intentText: "work on checkout flow",
    topicConfirmed: false,
    trackerTarget: {
      kind: "github",
      owner: "ctxr-dev",
      repo: "agent-staff-engineer",
    },
    answers: [],
  };
  return { ...base, ...overrides };
}

describe("issueDiscovery.newSessionId", () => {
  it("produces a deterministic-friendly id matching the schema pattern", () => {
    const now = new Date("2026-04-21T12:34:56Z");
    const rand = Buffer.from([0xab, 0xcd]);
    const id = newSessionId({ now, rand });
    assert.equal(id, "20260421-123456-abcd");
    assert.match(id, /^[0-9]{8}-[0-9]{6}-[A-Za-z0-9_-]{4,16}$/);
  });

  it("pads single-digit months / days / hours / minutes / seconds", () => {
    const now = new Date("2026-01-02T03:04:05Z");
    const rand = Buffer.from([0x00, 0x01]);
    const id = newSessionId({ now, rand });
    assert.equal(id, "20260102-030405-0001");
  });

  it("uses random bytes when `rand` is omitted but still matches the pattern", () => {
    const id = newSessionId();
    assert.match(id, /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
  });

  it("rejects an invalid Date", () => {
    assert.throws(() => newSessionId({ now: new Date("not a date") }), /valid Date/);
  });
});

describe("issueDiscovery.slugFromIntent", () => {
  it("returns 6 base32-ish chars for any intent string", () => {
    const a = slugFromIntent("hello world");
    const b = slugFromIntent("hello world");
    assert.equal(a, b);
    assert.match(a, /^[a-z2-7]{6}$/);
  });

  it("normalises whitespace and case so equivalent intents get the same slug", () => {
    assert.equal(
      slugFromIntent("  The CHECKOUT flow  "),
      slugFromIntent("the checkout flow"),
    );
  });

  it("different intents get different slugs with overwhelming probability", () => {
    assert.notEqual(slugFromIntent("alpha"), slugFromIntent("beta"));
  });
});

describe("issueDiscovery.writeSession / readSession schema enforcement", () => {
  it("round-trips a valid state through the session-scoped helper", async () => {
    const state = makeValidState("20260421-120000-aaaa");
    await writeSession(scratch, "20260421-120000-aaaa", state, SESSION_SCHEMA);
    const { state: roundTripped, errors } = await readSession(scratch, "20260421-120000-aaaa", SESSION_SCHEMA);
    assert.deepEqual(errors, []);
    assert.deepEqual(roundTripped, state);
  });

  it("refuses to write a state missing required fields", async () => {
    const bad = { sessionId: "20260421-120000-bbbb", version: 1 }; // missing startedAt, currentStep, etc.
    await assert.rejects(
      () => writeSession(scratch, "20260421-120000-bbbb", bad, SESSION_SCHEMA),
      /fails schema/,
    );
  });

  it("returns state: null with errors when the on-disk file fails schema", async () => {
    // Write a corrupted state bypassing the schema-enforced writer.
    const { writeSession: rawWriteSession } = await import("../scripts/lib/sessionState.mjs");
    await rawWriteSession(scratch, DOMAIN_NAME, "20260421-120000-cccc", { whatever: "bad" });
    const { state, errors } = await readSession(scratch, "20260421-120000-cccc", SESSION_SCHEMA);
    assert.equal(state, null);
    assert.ok(errors.length > 0, "expected schema errors surfaced");
  });

  it("returns state: null when the file is missing, without any errors", async () => {
    const { state, errors } = await readSession(scratch, "missing-id-ffff", SESSION_SCHEMA);
    assert.equal(state, null);
    assert.deepEqual(errors, []);
  });
});

describe("issueDiscovery.listPendingSessions + archiveSession", () => {
  it("lists only non-archived sessions and archives with the right suffix", async () => {
    const fresh = makeValidState("20260426-100000-dddd");
    const older = makeValidState("20260425-100000-eeee", { startedAt: "2026-04-25T10:00:00Z" });
    await writeSession(scratch, "20260426-100000-dddd", fresh, SESSION_SCHEMA);
    await writeSession(scratch, "20260425-100000-eeee", older, SESSION_SCHEMA);

    const before = await listPendingSessions(scratch);
    const idsBefore = before.map((e) => e.sessionId).sort();
    assert.ok(idsBefore.includes("20260426-100000-dddd"));
    assert.ok(idsBefore.includes("20260425-100000-eeee"));

    const archivedPath = await archiveSession(scratch, "20260425-100000-eeee", "completed");
    assert.ok(archivedPath.endsWith("20260425-100000-eeee.completed.json"));

    const after = await listPendingSessions(scratch);
    const idsAfter = after.map((e) => e.sessionId);
    assert.ok(!idsAfter.includes("20260425-100000-eeee"));
  });

  it("rejects an archival outcome outside the documented set", async () => {
    await assert.rejects(
      () => archiveSession(scratch, "anything", "bogus"),
      /outcome must be "completed", "cancelled", or "timed-out"/,
    );
  });
});

describe("issueDiscovery: 24-hour staleness signal", () => {
  it("listPendingSessions exposes ageMs so callers can decide the default resume answer", async () => {
    const long = makeValidState("20260420-000000-ffff", { startedAt: "2026-04-20T00:00:00Z" });
    await writeSession(scratch, "20260420-000000-ffff", long, SESSION_SCHEMA);
    const pending = await listPendingSessions(scratch);
    const hit = pending.find((e) => e.sessionId === "20260420-000000-ffff");
    assert.ok(hit, "expected session to show up in pending list");
    assert.ok(Number.isFinite(hit.ageMs));
    // Entry's startedAt is in the past; age must be >= 0.
    assert.ok(hit.ageMs >= 0);
  });
});
