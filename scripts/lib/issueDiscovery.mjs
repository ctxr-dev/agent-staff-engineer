// lib/issueDiscovery.mjs
// Library surface for the issue-discovery skill. Provides:
//   - DECISION_TREE: a pure data structure describing every node of
//     the intake state machine, its predecessors, option counts, and
//     halt conditions. The skill's SKILL.md and runbook.md read this
//     file's JSDoc as the single source of truth; the tests in
//     tests/issue_discovery_decision_tree.test.mjs assert its shape.
//   - newSessionId / scoreArea / rankIssuesForShortlist: pure helpers
//     the interview uses. No I/O, no tracker calls, no user prompts.
//   - readSession / writeSession / archiveSession: thin wrappers over
//     scripts/lib/sessionState.mjs scoped to the "issue-discovery"
//     domain, with schema validation on every read.
//
// Everything in this module is deterministic and side-effect-free
// except for the async session-state I/O wrappers. The interview
// itself (the "ask a question and wait for the user") lives in the
// agent's conversation layer; this library is just the
// deterministic pieces plus thin async wrappers for persisted
// session state.

import { createHash, randomBytes } from "node:crypto";

import {
  readSession as rawReadSession,
  writeSession as rawWriteSession,
  listPendingSessions as rawListPending,
  archiveSession as rawArchive,
} from "./sessionState.mjs";
import { validate } from "./schema.mjs";

const DOMAIN = "issue-discovery";

/**
 * Guard the schema argument on the library's public read/write
 * surface. `validate` would otherwise crash with a low-level Ajv
 * error (WeakMap lookup on `null`, etc.) and the caller wouldn't
 * know which parameter was missing. Explicit TypeError names the
 * parameter and the calling method.
 */
function assertSessionSchema(sessionSchema, method) {
  if (sessionSchema === null || typeof sessionSchema !== "object" || Array.isArray(sessionSchema)) {
    throw new TypeError(
      `issueDiscovery.${method}: sessionSchema must be a plain object (load it via readJsonOrNull from schemas/issue-discovery-session.schema.json); got ${JSON.stringify(sessionSchema)}`,
    );
  }
}

/**
 * Decision-tree descriptor. Each node has:
 *   - id: stable string used in session.currentStep.
 *   - predecessors: valid incoming node ids (or ["ENTRY"] for Q0).
 *   - next: array of branch descriptors. Each descriptor names a
 *     condition and a target node id (or "EXIT"). Conditions are
 *     documented in prose; the runtime chooses a branch based on
 *     the user's answer and the node-specific handler.
 *   - minOptions / maxOptions: the 2-4 option contract (null for
 *     free-form nodes like Q3b-title, Q5.2-goal).
 *   - canHalt: whether the node can halt per rules/ambiguity-halt.md.
 *   - customEscape: true iff the node exposes a "something else" /
 *     "I'll write my own" option that, when chosen with an answer
 *     outside the configured surface, triggers a halt.
 *
 * Every field is data only. The tests treat this as the spec; if
 * you change the state machine, change this and the runbook in the
 * same PR.
 */
export const DECISION_TREE = Object.freeze({
  entry: Object.freeze({
    id: "ENTRY",
    predecessors: Object.freeze([]),
    next: Object.freeze([
      { target: "q0", when: "topicConfirmationEnabled" },
      { target: "q1", when: "topicConfirmationDisabled" },
    ]),
    minOptions: null,
    maxOptions: null,
    canHalt: true,
    customEscape: false,
    description:
      "Load ops.config.json, confirm at least one writable trackers.dev, pre-fetch open issues + umbrellas + labels via tracker-sync. No user prompt; halts on no-writable-target. Advances to q0 when workflow.issue_discovery.topic_confirmation is true (the default); advances directly to q1 when it has been explicitly disabled.",
  }),
  q0: Object.freeze({
    id: "q0",
    predecessors: Object.freeze(["ENTRY"]),
    next: Object.freeze([{ target: "q1", when: "topicConfirmed" }]),
    minOptions: 2,
    maxOptions: 3,
    canHalt: true,
    customEscape: false,
    description: "Topic confirmation. Runs iff workflow.issue_discovery.topic_confirmation !== false.",
  }),
  q1: Object.freeze({
    id: "q1",
    predecessors: Object.freeze(["ENTRY", "q0"]),
    next: Object.freeze([{ target: "q2", when: "trackerTargetSelected" }]),
    minOptions: 2,
    maxOptions: 4,
    canHalt: true,
    customEscape: true,
    description:
      "Project / workspace-member selection. Skipped iff exactly one writable target AND no workspace.members[]. Accepts ENTRY as a predecessor when workflow.issue_discovery.topic_confirmation is false and q0 is skipped entirely.",
  }),
  q2: Object.freeze({
    id: "q2",
    predecessors: Object.freeze(["q1"]),
    next: Object.freeze([
      { target: "q3a", when: "pickExisting" },
      { target: "q3b", when: "fileNew" },
    ]),
    minOptions: 2,
    maxOptions: 3,
    canHalt: false,
    customEscape: false,
    description: "Existing or new. Skipped to q3b when the target has zero open issues.",
  }),
  q3a: Object.freeze({
    id: "q3a",
    predecessors: Object.freeze(["q2"]),
    next: Object.freeze([
      { target: "q6", when: "existingPicked" },
      { target: "q3b", when: "noneFitFileNew" },
    ]),
    minOptions: 2,
    maxOptions: 4,
    canHalt: true,
    customEscape: false,
    description: "Shortlist of top-4 open issues + show-more + file-new options.",
  }),
  q3b: Object.freeze({
    id: "q3b",
    predecessors: Object.freeze(["q2", "q3a"]),
    next: Object.freeze([{ target: "q3c", when: "titleRecorded" }]),
    minOptions: 2,
    maxOptions: 4,
    canHalt: false,
    // The "I'll write the title myself" option is free-form
    // acceptance, not an adapt-system escape hatch; a title is
    // inherently user-authored and has no configured surface to
    // fall outside of. `customEscape` is strictly for nodes where
    // a custom value requires a schema / labels / config change
    // (areas, intents, trackers, types).
    customEscape: false,
    description: "Title. 1-3 proposals + free-form (no halt).",
  }),
  q3c: Object.freeze({
    id: "q3c",
    predecessors: Object.freeze(["q3b"]),
    next: Object.freeze([{ target: "q3d", when: "typeSelected" }]),
    minOptions: 4,
    maxOptions: 4,
    canHalt: false,
    customEscape: false,
    description: "Issue type. Skipped when the caller pre-filled type.",
  }),
  q3d: Object.freeze({
    id: "q3d",
    predecessors: Object.freeze(["q3c"]),
    next: Object.freeze([{ target: "q3e-priority", when: "areaSelected" }]),
    minOptions: 2,
    maxOptions: 4,
    canHalt: true,
    customEscape: true,
    description: "Area label. Top-3 scored from intent + custom (halts on unknown area).",
  }),
  "q3e-priority": Object.freeze({
    id: "q3e-priority",
    predecessors: Object.freeze(["q3d"]),
    next: Object.freeze([{ target: "q3e-size", when: "prioritySelected" }]),
    minOptions: 3,
    maxOptions: 3,
    canHalt: false,
    customEscape: false,
    description: "Priority: high / medium / low.",
  }),
  "q3e-size": Object.freeze({
    id: "q3e-size",
    predecessors: Object.freeze(["q3e-priority"]),
    next: Object.freeze([{ target: "q3f", when: "sizeSelected" }]),
    minOptions: 3,
    maxOptions: 3,
    canHalt: false,
    customEscape: false,
    description: "Size: small / medium / large.",
  }),
  q3f: Object.freeze({
    id: "q3f",
    predecessors: Object.freeze(["q3e-size"]),
    next: Object.freeze([{ target: "q4a", when: "umbrellasExist" }, { target: "q4c", when: "umbrellasAbsent" }, { target: "q6", when: "releaseOptedOut" }]),
    minOptions: 3,
    maxOptions: 3,
    canHalt: false,
    customEscape: false,
    description:
      "Acceptance criteria. Three fixed options (write now / use template placeholders / exploratory). Jumps to q6 when trackers.release is absent, otherwise to q4a or q4c depending on whether umbrellas exist.",
  }),
  q4a: Object.freeze({
    id: "q4a",
    predecessors: Object.freeze(["q3f", "q5.8"]),
    next: Object.freeze([{ target: "q6", when: "umbrellaDecided" }]),
    minOptions: 2,
    maxOptions: 4,
    canHalt: true,
    customEscape: true,
    description: "Pick or skip umbrella (>=1 open exists). Halts on ambiguous multi-match.",
  }),
  q4c: Object.freeze({
    id: "q4c",
    predecessors: Object.freeze(["q3f"]),
    next: Object.freeze([
      { target: "q5.1", when: "createNew" },
      { target: "q6", when: "skipUmbrella" },
    ]),
    minOptions: 2,
    maxOptions: 2,
    canHalt: false,
    customEscape: false,
    description: "No umbrellas exist: offer create-new or skip.",
  }),
  "q5.1": Object.freeze({
    id: "q5.1",
    predecessors: Object.freeze(["q4c"]),
    next: Object.freeze([{ target: "q5.2", when: "intentSelected" }]),
    minOptions: 2,
    maxOptions: 4,
    canHalt: true,
    customEscape: true,
    description: "Intent label value; halts when user picks new:<slug> (adapt-system hint).",
  }),
  "q5.2": Object.freeze({
    id: "q5.2",
    predecessors: Object.freeze(["q5.1"]),
    next: Object.freeze([{ target: "q5.3", when: "goalRecorded" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Free-form umbrella goal (minimum 30 chars).",
  }),
  "q5.3": Object.freeze({
    id: "q5.3",
    predecessors: Object.freeze(["q5.2"]),
    next: Object.freeze([{ target: "q5.4", when: "scopeTagRecorded" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Free-form scope tag (kebab-cased).",
  }),
  "q5.4": Object.freeze({
    id: "q5.4",
    predecessors: Object.freeze(["q5.3"]),
    next: Object.freeze([{ target: "q5.5", when: "targetDateRecorded" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Target date YYYY-MM-DD or 'none'.",
  }),
  "q5.5": Object.freeze({
    id: "q5.5",
    predecessors: Object.freeze(["q5.4"]),
    next: Object.freeze([{ target: "q5.6", when: "nonGoalsRecorded" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Non-goals (free-form bullets or 'none').",
  }),
  "q5.6": Object.freeze({
    id: "q5.6",
    predecessors: Object.freeze(["q5.5"]),
    next: Object.freeze([{ target: "q5.7", when: "dodRecorded" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Definition of done; must include 'tested', 'released', 'monitored'.",
  }),
  "q5.7": Object.freeze({
    id: "q5.7",
    predecessors: Object.freeze(["q5.6"]),
    next: Object.freeze([{ target: "q5.8", when: "rollbackRecorded" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Rollback plan (minimum 20 chars).",
  }),
  "q5.8": Object.freeze({
    id: "q5.8",
    predecessors: Object.freeze(["q5.7"]),
    next: Object.freeze([{ target: "q4a", when: "umbrellaCreated" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description:
      "Stakeholders; triggers release-tracker.createUmbrellaForIntent, then loops back to q4a for explicit confirmation.",
  }),
  q6: Object.freeze({
    id: "q6",
    predecessors: Object.freeze(["q3a", "q3f", "q4a", "q4c"]),
    next: Object.freeze([{ target: "done", when: "proceed" }, { target: "EXIT", when: "cancel" }]),
    minOptions: 3,
    maxOptions: 3,
    canHalt: true,
    customEscape: false,
    description:
      "Confirmation gate. The only node that dispatches tracker-sync.issues.createIssue (via the conversation layer after the user picks Proceed).",
  }),
  done: Object.freeze({
    id: "done",
    predecessors: Object.freeze(["q6"]),
    next: Object.freeze([{ target: "EXIT", when: "archived" }]),
    minOptions: null,
    maxOptions: null,
    canHalt: false,
    customEscape: false,
    description: "Terminal success state; session is archived as .completed.json.",
  }),
});

/**
 * Generate a deterministic-friendly session id. Format:
 *   YYYYMMDD-HHMMSS-<4 hex>
 * Timestamp is UTC so listings sort chronologically. The hex
 * suffix prevents collisions when two sessions open in the same
 * second. Accepts an optional `now` (Date) and `rand` (Buffer) for
 * test determinism.
 */
export function newSessionId({ now, rand } = {}) {
  const d = now instanceof Date ? now : new Date();
  if (Number.isNaN(d.getTime())) {
    throw new TypeError("issueDiscovery.newSessionId: `now` must be a valid Date");
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  const bytes = Buffer.isBuffer(rand) && rand.length >= 2 ? rand : randomBytes(2);
  const hex = bytes.slice(0, 2).toString("hex");
  return `${stamp}-${hex}`;
}

/**
 * Score one candidate `area` against the user's free-form intent.
 * Deterministic: case-insensitive keyword hits, normalised to [0, 1].
 * Returns `{ score, matchedKeywords }`. Areas get a non-zero floor
 * of 0 (never NaN, never negative) so every configured area is a
 * surfaceable option even when no keyword matched.
 *
 * Input shape:
 *   area = { name: "checkout", keywords: ["cart", "checkout", "payment"] }
 */
export function scoreArea(intent, area) {
  if (typeof intent !== "string") return { score: 0, matchedKeywords: [] };
  if (!area || typeof area !== "object") return { score: 0, matchedKeywords: [] };
  const keywords = Array.isArray(area.keywords) ? area.keywords : [];
  if (keywords.length === 0) return { score: 0, matchedKeywords: [] };
  const hay = intent.toLowerCase();
  const matched = [];
  for (const kw of keywords) {
    if (typeof kw !== "string" || kw.length === 0) continue;
    if (hay.includes(kw.toLowerCase())) matched.push(kw);
  }
  const score = matched.length / keywords.length;
  return { score, matchedKeywords: matched };
}

/**
 * Rank open issues for the Q3a shortlist. Deterministic ordering by:
 *   priority descending (high > medium > low > undefined)
 *   age descending within priority (older first, more important)
 *
 * Accepts an array of {number, title, priority, createdAt, labels}
 * and returns the top `cap` entries. `cap` defaults to 4 for the
 * initial shortlist; Q3a's "show more" calls with 8.
 */
export function rankIssuesForShortlist(issues, cap = 4) {
  if (!Array.isArray(issues)) return [];
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new TypeError(`rankIssuesForShortlist: cap must be a positive integer; got ${JSON.stringify(cap)}`);
  }
  const priorityRank = (p) => {
    if (p === "high") return 3;
    if (p === "medium") return 2;
    if (p === "low") return 1;
    return 0;
  };
  const parseTime = (t) => {
    const n = typeof t === "string" ? Date.parse(t) : Number.NaN;
    return Number.isFinite(n) ? n : Number.NaN;
  };
  const sorted = issues
    .filter((i) => i && typeof i.number === "number" && typeof i.title === "string")
    .slice()
    .sort((a, b) => {
      const pa = priorityRank(a.priority);
      const pb = priorityRank(b.priority);
      if (pa !== pb) return pb - pa;
      const ta = parseTime(a.createdAt);
      const tb = parseTime(b.createdAt);
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      if (Number.isFinite(ta)) return -1;
      if (Number.isFinite(tb)) return 1;
      return 0;
    });
  return sorted.slice(0, cap);
}

/**
 * Return a stable 6-char slug derived from the intent text. Used
 * anywhere a deterministic, compact alphanumeric identifier is
 * needed from user-visible intent text: title-proposal generation
 * at Q3b, any "open-or-resume" key the skill wants keyed on intent
 * rather than time. Not used in `newSessionId` today (session ids
 * use random hex so two sessions started from the same intent text
 * still get distinct ids). sha1 + base32-ish alphabet keeps the
 * slug alphanumeric and collision-rare without pulling in a UUID
 * library.
 */
export function slugFromIntent(intent) {
  const normalised = typeof intent === "string" ? intent.trim().toLowerCase() : "";
  const h = createHash("sha1").update(normalised).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const out = [];
  for (let i = 0; i < 6; i++) {
    out.push(alphabet[h[i] % 32]);
  }
  return out.join("");
}

/**
 * Read a session and validate against the session-state schema.
 * Returns `{ state, errors }`. When the file is missing returns
 * `{ state: null, errors: [] }`. Malformed JSON (readJsonOrNull
 * throws on parse errors) and schema violations both surface
 * under `errors` so the caller can halt with a pointed message
 * rather than crashing on a property access.
 */
export async function readSession(target, sessionId, sessionSchema) {
  assertSessionSchema(sessionSchema, "readSession");
  let state;
  try {
    state = await rawReadSession(target, DOMAIN, sessionId);
  } catch (error) {
    return {
      state: null,
      errors: [
        {
          path: "$",
          message:
            error instanceof Error
              ? `failed to read session: ${error.message}`
              : `failed to read session: ${String(error)}`,
        },
      ],
    };
  }
  if (state === null) return { state: null, errors: [] };
  const { ok, errors } = validate(sessionSchema, state);
  return { state: ok ? state : null, errors };
}

/**
 * Write a validated session state. Returns a rejected promise (the
 * function is async) if the state doesn't match the schema; a
 * sketchy write would otherwise manifest as a malformed-file error
 * on the next read. Callers should `await` or `.catch(...)` the
 * rejection rather than expecting a synchronous throw.
 */
export async function writeSession(target, sessionId, state, sessionSchema) {
  assertSessionSchema(sessionSchema, "writeSession");
  const { ok, errors } = validate(sessionSchema, state);
  if (!ok) {
    const summary = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new TypeError(
      `issueDiscovery.writeSession: session state fails schema at [${summary}]`,
    );
  }
  return rawWriteSession(target, DOMAIN, sessionId, state);
}

/**
 * List pending (non-archived) issue-discovery sessions in a target.
 * Thin wrapper over sessionState.listPendingSessions scoped to the
 * "issue-discovery" domain.
 */
export async function listPendingSessions(target) {
  return rawListPending(target, DOMAIN);
}

/**
 * Archive a session. Outcome is one of the documented terminal
 * labels: "completed" (Q6 Proceed), "cancelled" (Q6 Cancel),
 * "timed-out" (future use once PR 14's session-resume rule lands).
 */
export async function archiveSession(target, sessionId, outcome) {
  if (outcome !== "completed" && outcome !== "cancelled" && outcome !== "timed-out") {
    throw new TypeError(
      `issueDiscovery.archiveSession: outcome must be "completed", "cancelled", or "timed-out"; got ${JSON.stringify(outcome)}`,
    );
  }
  return rawArchive(target, DOMAIN, sessionId, outcome);
}

/** Exposed for tests and adapt-system introspection. */
export const DOMAIN_NAME = DOMAIN;
