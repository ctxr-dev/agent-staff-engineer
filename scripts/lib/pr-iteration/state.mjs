// lib/pr-iteration/state.mjs
// Persistent state for the wakeup-driven PR iteration loop. Each active PR
// gets one JSON file under .development/local/pr-iteration/, validated on
// read against schemas/pr-iteration-state.schema.json. All writes are
// atomic (write-to-temp then rename) via fsx.mjs.

import { readdir, unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWriteJson,
  atomicWriteText,
  exists,
  readJsonOrNull,
} from "../fsx.mjs";
import { validate } from "../schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  await readFile(
    join(__dirname, "..", "..", "..", "schemas", "pr-iteration-state.schema.json"),
    "utf8",
  ),
);

// Match owner/repo#number. Both owner and repo segments reject "/" and path
// separators so the derived filename is always a single path component.
const PR_ID_RE = /^([A-Za-z0-9_.][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.][A-Za-z0-9_.-]*)#(\d+)$/;

/**
 * Derive the state filename from a canonical prId ("owner/repo#123").
 * @param {string} prId
 * @returns {string} e.g. "owner__repo__123.json"
 */
export function stateFileName(prId) {
  const m = prId.match(PR_ID_RE);
  if (!m) throw new Error(`Invalid prId format: ${prId} (expected owner/repo#number)`);
  return `${m[1]}__${m[2]}__${m[3]}.json`;
}

function stateFilePath(stateDir, prId) {
  return join(stateDir, stateFileName(prId));
}

function sidecarPath(stateDir, prId, ext) {
  return stateFilePath(stateDir, prId).replace(/\.json$/, `.${ext}`);
}

/**
 * Read and validate a PR iteration state file.
 * @param {string} stateDir absolute path to the state directory
 * @param {string} prId     canonical PR identifier
 * @returns {Promise<object|null>} validated state or null when file absent
 * @throws on schema validation failure (corrupt file surfaces immediately)
 */
export async function readPrState(stateDir, prId) {
  const p = stateFilePath(stateDir, prId);
  const data = await readJsonOrNull(p);
  if (data == null) return null;
  const { ok, errors } = validate(SCHEMA, data);
  if (!ok) {
    const detail = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`PR state file ${p} failed schema validation:\n${detail}`);
  }
  return data;
}

/**
 * Atomically write a PR iteration state file. Sets updatedAt automatically.
 * @param {string} stateDir absolute path to the state directory
 * @param {object} state    state object (must have a valid prId)
 * @returns {Promise<string>} absolute path written
 */
export async function writePrState(stateDir, state) {
  state.updatedAt = new Date().toISOString();
  return atomicWriteJson(stateFilePath(stateDir, state.prId), state);
}

/**
 * List all pending (not stopped, not paused) PR iteration states.
 * Returns a deterministic (sorted by filename) array.
 * @param {string} stateDir absolute path to the state directory
 * @returns {Promise<Array<{prId: string, state: object}>>}
 */
export async function listPendingPrStates(stateDir) {
  let entries;
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const results = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    // Skip archived stopped states
    if (name.endsWith(".stopped.json")) continue;

    const base = name.replace(/\.json$/, "");
    const stoppedExists = await exists(join(stateDir, `${base}.stopped`));
    const pausedExists = await exists(join(stateDir, `${base}.paused`));
    if (stoppedExists || pausedExists) continue;

    const filePath = join(stateDir, name);
    const data = await readJsonOrNull(filePath);
    if (!data) continue;

    if (!data.prId) {
      throw new Error(
        `PR state file ${filePath} is missing the required prId field`,
      );
    }

    // Verify the prId inside the file matches the filename to detect
    // renames or edits that would cause write-back to the wrong file.
    const expectedName = stateFileName(data.prId);
    if (expectedName !== name) {
      throw new Error(
        `PR state file ${filePath}: prId "${data.prId}" does not match filename "${name}" (expected "${expectedName}")`,
      );
    }

    const { ok, errors } = validate(SCHEMA, data);
    if (!ok) {
      const detail = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
      throw new Error(`PR state file ${filePath} failed schema validation:\n${detail}`);
    }
    results.push({ prId: data.prId, state: data });
  }
  return results;
}

/**
 * Write a .stopped sidecar so when the next wakeup fires, it exits without rescheduling.
 * @param {string} stateDir absolute path to the state directory
 * @param {string} prId     canonical PR identifier
 * @param {string} reason   human-readable reason for stopping
 * @returns {Promise<string>} absolute path of the sidecar file
 */
export async function markPrStateStopped(stateDir, prId, reason) {
  const content = JSON.stringify(
    { reason, stoppedAt: new Date().toISOString() },
    null,
    2,
  ) + "\n";
  return atomicWriteText(sidecarPath(stateDir, prId, "stopped"), content);
}

/**
 * Write a .paused sidecar (safety cap reached). Human deletes the file to resume.
 * @param {string} stateDir absolute path to the state directory
 * @param {string} prId     canonical PR identifier
 * @param {string} reason   human-readable reason for pausing
 * @returns {Promise<string>} absolute path of the sidecar file
 */
export async function markPrStatePaused(stateDir, prId, reason) {
  const content = JSON.stringify(
    { reason, pausedAt: new Date().toISOString() },
    null,
    2,
  ) + "\n";
  return atomicWriteText(sidecarPath(stateDir, prId, "paused"), content);
}

/** Check whether a .stopped sidecar exists for the given PR. */
export async function isStateStopped(stateDir, prId) {
  return exists(sidecarPath(stateDir, prId, "stopped"));
}

/** Check whether a .paused sidecar exists for the given PR. */
export async function isStatePaused(stateDir, prId) {
  return exists(sidecarPath(stateDir, prId, "paused"));
}

/**
 * Remove the state file for a completed PR. Best-effort; ignores ENOENT.
 * @param {string} stateDir absolute path to the state directory
 * @param {string} prId     canonical PR identifier
 */
export async function removePrState(stateDir, prId) {
  try {
    await unlink(stateFilePath(stateDir, prId));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export { SCHEMA as PR_ITERATION_STATE_SCHEMA };
