// lib/fsx.mjs
// File-system helpers used by the installer and friends. Zero npm deps.
// Every write goes through an atomic "write-to-temp then rename" path.

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  stat,
  symlink,
  unlink,
  access,
} from "node:fs/promises";
import {
  constants as fsConstants,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Ensure a directory exists (recursive mkdir). Returns the absolute path. */
export async function ensureDir(dir) {
  const abs = resolve(dir);
  await mkdir(abs, { recursive: true });
  return abs;
}

/** Does the path exist? */
export async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read a file as UTF-8 text, or return null when the file does not exist
 *  OR when the path points at a directory (common user accident). */
export async function readTextOrNull(p) {
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EISDIR")) return null;
    throw err;
  }
}

/** Is the given path an existing directory (as opposed to a file, missing, etc.)? */
export async function isDirectory(p) {
  const s = await statOrNull(p);
  return !!s && s.isDirectory();
}

/** Read and parse JSON, or return null when the file does not exist. Wraps parse errors with the file path. */
export async function readJsonOrNull(p) {
  const text = await readTextOrNull(p);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${p}: ${err.message}`);
  }
}

// Shared tmp-name helper so the async + sync atomic helpers do not drift
// on suffix shape. Format: "<abs>.tmp-<pid>-<ms>-<rand8>". Pid + ms keeps
// names readable in `ls`; the random fragment defeats sub-millisecond
// collisions when the same process writes the same target twice in quick
// succession (which Date.now() alone does not).
function tmpPathFor(abs) {
  const rand = createHash("sha256")
    .update(`${abs}|${process.pid}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
  return `${abs}.tmp-${process.pid}-${Date.now()}-${rand}`;
}

/** Atomic write: write to "<path>.tmp" then rename to "<path>". Creates parent dirs. Cleans up the temp file
 *  if anything fails in between. Same-filesystem requirement: rename is only atomic on one filesystem; callers
 *  should pass paths under the project root rather than crossing mount boundaries. */
export async function atomicWriteText(p, content) {
  const abs = resolve(p);
  await ensureDir(dirname(abs));
  const tmp = tmpPathFor(abs);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, abs);
    return abs;
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/** Atomic write for a JSON object, pretty-printed with 2-space indent and trailing newline. */
export async function atomicWriteJson(p, obj) {
  const content = JSON.stringify(obj, null, 2) + "\n";
  return atomicWriteText(p, content);
}

/**
 * Sync sibling of atomicWriteText. Same write-to-temp + rename contract,
 * same cleanup-on-failure semantics; differs only in being synchronous.
 *
 * Exists because some writers (notably scripts/lib/knowledge/write.mjs)
 * orchestrate sync-only sequences (spawnSync into skill-llm-wiki, sync
 * fs ops) and benefit from a single synchronous control flow. Centralising
 * the temp naming + rename + unlink-on-failure here keeps the two
 * variants from drifting on tmp suffix shape, encoding, or cleanup
 * behaviour.
 *
 * @param {string} p        absolute or relative path; resolved here
 * @param {string} content  text payload (utf-8)
 * @returns {string}        the absolute path that was written
 */
export function atomicWriteTextSync(p, content) {
  const abs = resolve(p);
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = tmpPathFor(abs);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, abs);
    return abs;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Walk a directory recursively, yielding absolute file paths. Skips entries whose names start with "." by default.
 *  Safe against symlink cycles: follows symlinks only when options.followSymlinks is true, and tracks visited real
 *  paths via a Set to break cycles. */
export async function* walkFiles(dir, options = {}) {
  const includeHidden = options.includeHidden ?? false;
  const ignoreDirs = new Set(options.ignoreDirs ?? [".git", "node_modules"]);
  const followSymlinks = options.followSymlinks ?? false;
  const visited = options._visited ?? new Set();
  const { realpath } = await import("node:fs/promises");
  let here;
  try {
    here = await realpath(dir);
  } catch {
    return;
  }
  if (visited.has(here)) return;
  visited.add(here);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!includeHidden && e.name.startsWith(".") && e.name !== ".") continue;
    if (e.isSymbolicLink() && !followSymlinks) continue;
    if (e.isDirectory()) {
      if (ignoreDirs.has(e.name)) continue;
      yield* walkFiles(join(dir, e.name), { ...options, _visited: visited });
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

/** Create a symlink, replacing an existing one if present. */
export async function ensureSymlink(target, linkPath) {
  const abs = resolve(linkPath);
  await ensureDir(dirname(abs));
  if (await exists(abs)) {
    await unlink(abs);
  }
  await symlink(target, abs);
  return abs;
}

/** Compute a sha256 hex digest for a string or Buffer. */
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Relative path helper that always emits POSIX-style separators (useful in wrapper include paths). */
export function relPosix(from, to) {
  return relative(from, to).split(/[\\/]+/).join("/");
}

/** Is `child` inside `parent`? Both are absolute paths. */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/") && !rel.includes(":");
}

/** Best-effort file stat; returns null when missing. */
export async function statOrNull(p) {
  try {
    return await stat(p);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Resolve a path through realpath; on ENOENT, print a friendly message
 * identifying the `label` and exit the process with code 1. Used by the CLI
 * scripts so users never see a raw ENOENT stack trace when they mistype
 * --target or try to run against a missing bundle.
 * @param {string} p absolute path to resolve
 * @param {"bundle" | "target" | string} label informative name for the error message
 * @returns {Promise<string>} resolved real path
 */
export async function safeRealpathOrExit(p, label = "path") {
  const { realpath } = await import("node:fs/promises");
  try {
    return await realpath(p);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      const hint =
        label === "bundle"
          ? "Clone the agent bundle first, or run 'npx @ctxr/kit install @ctxr/agent-staff-engineer'.\n"
          : label === "target"
          ? "Pass --target <existing-project-path> or run from inside the target project.\n"
          : `Ensure the ${label} exists before running this command.\n`;
      process.stderr.write(`${label} path not found: ${p}\n${hint}`);
      process.exit(1);
    }
    throw err;
  }
}
