// lib/sessionState.mjs
// Shared scratch-state helper for skills that persist cross-session
// ephemeral data (issue-discovery today, pr-iteration when PR 14 lands,
// other future skills). Everything here operates on JSON files under
// `<target>/.development/local/<domain>/<session-id>.json`, which the
// bundle's standing `.development/local/` convention gitignores.
//
// The helper is intentionally small. It does not know about any
// specific domain's schema. Callers validate their own state shape
// after `readSession` returns (typically via scripts/lib/schema.mjs).
//
// Lifecycle:
//   - writeSession(target, domain, sessionId, state) -> atomic JSON write
//   - readSession(target, domain, sessionId) -> parsed JSON or null
//   - listPendingSessions(target, domain) -> [{sessionId, path, state, ageMs}]
//   - archiveSession(target, domain, sessionId, outcome) -> renames the
//     file to "<sessionId>.<outcome>.json" (e.g. outcome "completed" or
//     "cancelled") so a future scan doesn't see it as pending. Outcome
//     is a caller-chosen suffix; it must already be kebab-case ASCII,
//     and the helper rejects anything else (via OUTCOME_RE) to keep
//     listings scannable. No transformation is applied.
//
// Everything is side-effect-isolated to `<target>/.development/local/<domain>/`.
// The helper refuses to operate outside that subtree.

import { join, resolve, basename } from "node:path";
import { readdir, stat, rename } from "node:fs/promises";
import {
  ensureDir,
  atomicWriteJson,
  readJsonOrNull,
  isDirectory,
} from "./fsx.mjs";

// kebab-case ASCII; rejects slashes, dots, whitespace, unicode. Keeps
// listings safe across macOS/Linux/Windows and defuses any "outcome"
// value that a caller might accidentally pass through from user input.
const OUTCOME_RE = /^[a-z][a-z0-9-]{0,30}$/;

// Session ID must be filesystem-safe. Enforced here too (not just in
// schemas) so listSessions never surfaces an arbitrary attacker-chosen
// filename. The validate-on-read in caller-specific lib enforces the
// stronger pattern (e.g. "<YYYYMMDD-HHMMSS>-<slug>").
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN_RE = /^[a-z][a-z0-9-]{0,30}$/;

function assertTargetAbs(target, label) {
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new TypeError(`sessionState.${label}: target must be a non-empty string`);
  }
}

function assertDomain(domain, label) {
  if (!DOMAIN_RE.test(domain ?? "")) {
    throw new TypeError(
      `sessionState.${label}: domain must be kebab-case ASCII (^[a-z][a-z0-9-]{0,30}$); got ${JSON.stringify(domain)}`,
    );
  }
}

function assertSessionId(sessionId, label) {
  if (!SESSION_ID_RE.test(sessionId ?? "")) {
    throw new TypeError(
      `sessionState.${label}: sessionId must match ^[A-Za-z0-9_-]{1,64}$; got ${JSON.stringify(sessionId)}`,
    );
  }
}

function sessionDir(target, domain) {
  return join(resolve(target), ".development", "local", domain);
}

function sessionPath(target, domain, sessionId, suffix = "") {
  const filename = suffix ? `${sessionId}.${suffix}.json` : `${sessionId}.json`;
  return join(sessionDir(target, domain), filename);
}

/**
 * Atomically write a session state file. Creates the session directory
 * if missing. The caller is responsible for validating `state` against
 * its domain schema before calling this; the helper does NOT validate.
 *
 * Returns the absolute path the file was written to.
 */
export async function writeSession(target, domain, sessionId, state) {
  assertTargetAbs(target, "writeSession");
  assertDomain(domain, "writeSession");
  assertSessionId(sessionId, "writeSession");
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError(
      `sessionState.writeSession: state must be a plain object; got ${JSON.stringify(state)}`,
    );
  }
  const dir = sessionDir(target, domain);
  await ensureDir(dir);
  const path = sessionPath(target, domain, sessionId);
  return atomicWriteJson(path, state);
}

/**
 * Read a session state file. Returns `null` when the file doesn't
 * exist. Throws on malformed JSON (same as `readJsonOrNull`) so the
 * caller sees a file-specific parse error rather than a silent null.
 */
export async function readSession(target, domain, sessionId) {
  assertTargetAbs(target, "readSession");
  assertDomain(domain, "readSession");
  assertSessionId(sessionId, "readSession");
  return readJsonOrNull(sessionPath(target, domain, sessionId));
}

/**
 * Enumerate every non-archived session in the domain directory.
 * Returns `[{sessionId, path, state, ageMs}]` sorted by startedAt
 * ascending (when state has a startedAt field; falls back to mtime).
 *
 * Archived files (`*.<outcome>.json` where outcome matches
 * OUTCOME_RE) are skipped; this is what lets the list reflect
 * "pending" sessions only. Malformed files are surfaced with a
 * `state: null, error: string` entry rather than dropping them
 * silently — callers can decide whether to log or to halt.
 */
export async function listPendingSessions(target, domain) {
  assertTargetAbs(target, "listPendingSessions");
  assertDomain(domain, "listPendingSessions");
  const dir = sessionDir(target, domain);
  if (!(await isDirectory(dir))) return [];
  const entries = await readdir(dir);
  const now = Date.now();
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = basename(entry, ".json");
    const path = join(dir, entry);
    // Archived file shape: <sessionId>.<outcome>.json. Split on the
    // first dot from the right and require BOTH halves to be valid
    // before skipping. A "weird" extra-dot name (hand-edit, partial
    // rename, crash mid-archival) gets surfaced as an error entry
    // rather than silently ignored, which was the docstring's
    // original promise.
    const lastDot = name.lastIndexOf(".");
    if (lastDot !== -1) {
      const head = name.slice(0, lastDot);
      const tail = name.slice(lastDot + 1);
      if (SESSION_ID_RE.test(head) && OUTCOME_RE.test(tail)) {
        // Valid archived file. Skip per the listPendingSessions contract.
        continue;
      }
      // Malformed: filename has a dot but neither half passes validation.
      out.push({
        sessionId: SESSION_ID_RE.test(head) ? head : name,
        path,
        state: null,
        ageMs: null,
        error: `Malformed session filename: expected <sessionId>.json or <sessionId>.<outcome>.json; got ${entry}`,
      });
      continue;
    }
    if (!SESSION_ID_RE.test(name)) {
      out.push({
        sessionId: name,
        path,
        state: null,
        ageMs: null,
        error: `Malformed session filename: invalid session id in ${entry}`,
      });
      continue;
    }
    try {
      const state = await readJsonOrNull(path);
      // readJsonOrNull returns null on EISDIR (directory named like
      // a session file) AND on a literal JSON `null`. Treat both as
      // malformed: a valid session is always a plain non-null
      // object per the session-state schema. Callers need a non-empty
      // `error` to tell corruption apart from legitimate state.
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        out.push({
          sessionId: name,
          path,
          state: null,
          ageMs: null,
          error: `Malformed session file: expected a plain JSON object; got ${state === null ? "null or directory" : typeof state}`,
        });
        continue;
      }
      const startedAt = typeof state.startedAt === "string" ? Date.parse(state.startedAt) : NaN;
      let ageMs;
      if (Number.isFinite(startedAt)) {
        // Clamp negatives to 0: clock skew, a hand-edited file, or a
        // corrupted startedAt can yield a future timestamp. Callers
        // use ageMs for staleness decisions + sorting, so a negative
        // value would invert the intended "oldest first" ordering.
        ageMs = Math.max(0, now - startedAt);
      } else {
        const s = await stat(path);
        ageMs = Math.max(0, now - s.mtimeMs);
      }
      out.push({ sessionId: name, path, state, ageMs });
    } catch (err) {
      out.push({ sessionId: name, path, state: null, ageMs: null, error: String(err?.message ?? err) });
    }
  }
  // Oldest first so the resume prompt surfaces the most-stale session
  // at the top; callers can re-sort if they want newest first.
  out.sort((a, b) => {
    const aAge = a.ageMs ?? Number.POSITIVE_INFINITY;
    const bAge = b.ageMs ?? Number.POSITIVE_INFINITY;
    return bAge - aAge;
  });
  return out;
}

/**
 * Rename a pending session to `<sessionId>.<outcome>.json` so it no
 * longer shows up in `listPendingSessions`. Idempotent: if the file
 * is already archived (or missing), returns null. Returns the new
 * absolute path on success.
 *
 * `outcome` is caller-chosen (`completed`, `cancelled`, `timed-out`);
 * validated against OUTCOME_RE to keep filenames safe and scannable.
 */
export async function archiveSession(target, domain, sessionId, outcome) {
  assertTargetAbs(target, "archiveSession");
  assertDomain(domain, "archiveSession");
  assertSessionId(sessionId, "archiveSession");
  if (!OUTCOME_RE.test(outcome ?? "")) {
    throw new TypeError(
      `sessionState.archiveSession: outcome must match ^[a-z][a-z0-9-]{0,30}$; got ${JSON.stringify(outcome)}`,
    );
  }
  const src = sessionPath(target, domain, sessionId);
  const dst = sessionPath(target, domain, sessionId, outcome);
  try {
    await rename(src, dst);
    return dst;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * For tests and programmatic inspection. Returns the absolute path
 * of the domain directory under the given target; does NOT create
 * the directory.
 */
export function sessionDirFor(target, domain) {
  assertTargetAbs(target, "sessionDirFor");
  assertDomain(domain, "sessionDirFor");
  return sessionDir(target, domain);
}
