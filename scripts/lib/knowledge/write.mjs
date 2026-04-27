// scripts/lib/knowledge/write.mjs
//
// Atomic write contract for one knowledge entry. Implements the
// 4-step sequence from the issue (#35):
//
//   1. Write markdown to <wikiRoot>/knowledge/<domain>/<slug>.md.
//   2. Validate frontmatter against schemas/knowledge-entry.schema.json
//      (this layer; skill-llm-wiki validate is the cross-cutting check
//      and is invoked by the caller via runSkillLlmWiki()).
//   3. Index-rebuild — see `runIndexRebuild()` below. Until
//      ctxr-dev/skill-llm-wiki#16 lands `--scope` (O(depth) chain
//      rebuild), this falls back to a full rebuild and logs a warning.
//   4. SQLite frontier reindex — STUB in this slice. See
//      `enqueueFrontierReindex()` notes below; a follow-up PR adds the
//      actual SQLite write.
//
// Failure semantics:
//   - Any step failing aborts and rolls back step 1 (the markdown file
//     is deleted) so the wiki tree never lands in a half-state.
//   - Step 4's stub is a soft failure: the function returns successfully
//     but writes a marker at .claude/state/reindex-pending so the next
//     run can fast-forward the SQLite layer once the follow-up lands.
//
// Pure-ish: writes to disk + invokes external CLIs; no network. Tests
// inject `runSkillLlmWiki` and `runIndexRebuild` to drive failure paths
// without needing the real CLI installed.

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { serialiseEntry } from "./frontmatter.mjs";
import { validateEntry } from "./validate.mjs";

/**
 * Write one knowledge entry through the atomic 4-step sequence.
 *
 * @param {object} args
 * @param {string} args.wikiRoot       absolute path to <paths.wiki>
 * @param {string} args.domain         domain slug under knowledge/ (e.g. "patterns", "incidents")
 * @param {string} args.slug           entry slug (matches data.id; written as <slug>.md)
 * @param {object} args.data           frontmatter object; full schema fields required
 * @param {string} args.body           markdown body; written verbatim
 * @param {string} [args.stateDir]     absolute path to project .claude/state (for the reindex-pending marker)
 * @param {object} [_deps]             test injection seam
 * @returns {{ ok: true, path: string, warnings: string[] } | { ok: false, error: string, step: number }}
 */
export function writeEntry(args, _deps = {}) {
  const { wikiRoot, domain, slug, data, body } = args;
  if (!isNonEmptyString(wikiRoot)) return fail(0, "writeEntry: wikiRoot is required");
  if (!isNonEmptyString(domain) || /[\\/]/.test(domain) || domain === ".." || domain.startsWith("."))
    return fail(0, `writeEntry: invalid domain ${JSON.stringify(domain)}`);
  if (!isNonEmptyString(slug) || !/^[a-z][a-z0-9-]*$/.test(slug))
    return fail(0, `writeEntry: invalid slug ${JSON.stringify(slug)} (must match /^[a-z][a-z0-9-]*$/)`);
  if (data == null || typeof data !== "object") return fail(0, "writeEntry: data must be an object");
  if (data.id !== slug) return fail(0, `writeEntry: data.id "${data.id}" must equal slug "${slug}"`);

  const validateFn = _deps.validateEntry ?? validateEntry;
  const runWikiValidate = _deps.runSkillLlmWiki ?? runSkillLlmWikiCli;
  const runRebuild = _deps.runIndexRebuild ?? runIndexRebuildCli;
  const enqueueReindex = _deps.enqueueFrontierReindex ?? enqueueFrontierReindexFile;

  const dir = resolve(wikiRoot, "knowledge", domain);
  const path = join(dir, `${slug}.md`);
  const warnings = [];

  // Step 1 — write markdown.
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, serialiseEntry(data, body));
  } catch (err) {
    return fail(1, `step 1 (write markdown): ${err?.message ?? String(err)}`);
  }

  // Step 2a — local frontmatter schema check.
  const local = validateFn(data, path);
  if (!local.ok) {
    rollback(path);
    return fail(2, `step 2 (local frontmatter validation): ${local.errors.join("; ")}`);
  }

  // Step 2b — skill-llm-wiki validate (full tree). The wiki layer
  // catches dangling parents, id-vs-filename mismatches we already
  // caught locally, depth-role rules, and slug uniqueness.
  const wikiResult = runWikiValidate(wikiRoot);
  if (!wikiResult.ok) {
    rollback(path);
    return fail(2, `step 2 (skill-llm-wiki validate): ${wikiResult.error}`);
  }

  // Step 3 — index rebuild for the parent chain. Until
  // ctxr-dev/skill-llm-wiki#16 lands `--scope`, the runner falls back
  // to full-tree rebuild and surfaces a warning.
  const rebuildResult = runRebuild(wikiRoot, dir);
  if (!rebuildResult.ok) {
    rollback(path);
    // We do not attempt to re-rebuild here; if the rebuild itself fails
    // the wiki may be inconsistent. Surface that plainly.
    return fail(3, `step 3 (index-rebuild): ${rebuildResult.error}`);
  }
  if (rebuildResult.scoped === false) {
    warnings.push(
      "skill-llm-wiki index-rebuild ran in full-tree mode; the chain-scoped variant lands in skill-llm-wiki#16. Latency is fine for small trees; revisit when the dep merges.",
    );
  }

  // Step 4 — SQLite frontier reindex. STUB until the follow-up PR adds
  // the actual sqlite writer. We write a marker so the next session-
  // start `--incremental` reindex can fast-forward.
  if (isNonEmptyString(args.stateDir)) {
    const enq = enqueueReindex(args.stateDir, path);
    if (!enq.ok) {
      // Soft failure: the wiki is consistent. We log the marker and let
      // the next session recover.
      warnings.push(`step 4 (frontier reindex): ${enq.error} (marker not written; the next session-start reindex must walk the wiki to recover)`);
    }
  }

  return { ok: true, path, warnings };
}

// ---------- internals ----------

function isNonEmptyString(s) {
  return typeof s === "string" && s.length > 0;
}

function fail(step, error) {
  return { ok: false, step, error };
}

function rollback(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort; if the file is already gone we're done.
  }
}

/**
 * Default CLI runner for `skill-llm-wiki validate`. Resolves the
 * binary as `skill-llm-wiki` on PATH; tests inject a stub via _deps.
 */
function runSkillLlmWikiCli(wikiRoot) {
  const result = spawnSync("skill-llm-wiki", ["validate", wikiRoot], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) return { ok: false, error: `spawn failed: ${result.error.message}` };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { ok: true };
}

/**
 * Default CLI runner for `skill-llm-wiki index-rebuild`. Tries the
 * scoped form first (`--scope <dir>`); on unrecognised flag it falls
 * back to the full-tree form and reports `scoped: false` so callers
 * can warn.
 */
function runIndexRebuildCli(wikiRoot, leafDir) {
  // Attempt scoped rebuild first. Once skill-llm-wiki#16 lands this is
  // O(depth) and finishes in well under a second on real trees.
  const scoped = spawnSync("skill-llm-wiki", ["index-rebuild", wikiRoot, "--scope", leafDir], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (!scoped.error && scoped.status === 0) {
    return { ok: true, scoped: true };
  }
  // If scoped failed because the flag isn't supported yet, fall back
  // to the full rebuild. We detect that case by inspecting the stderr;
  // any other failure (timeout, real validation failure) propagates.
  const stderr = (scoped.stderr || "").toLowerCase();
  const flagUnknown =
    stderr.includes("unknown") ||
    stderr.includes("unrecognised") ||
    stderr.includes("unrecognized") ||
    stderr.includes("usage:") ||
    scoped.error?.code === "ENOENT" === false && scoped.status !== 0 && stderr.includes("scope");
  if (!flagUnknown && scoped.error?.code !== undefined) {
    // Spawn itself failed (e.g. ENOENT). Surface that.
    return { ok: false, error: `spawn failed: ${scoped.error.message}` };
  }
  if (!flagUnknown && scoped.status !== 0) {
    return { ok: false, error: (scoped.stderr || scoped.stdout || `exit ${scoped.status}`).trim() };
  }
  // Fall back to full rebuild.
  const full = spawnSync("skill-llm-wiki", ["index-rebuild", wikiRoot], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (full.error) return { ok: false, error: `spawn failed: ${full.error.message}` };
  if (full.status !== 0) return { ok: false, error: (full.stderr || full.stdout || `exit ${full.status}`).trim() };
  return { ok: true, scoped: false };
}

/**
 * Default frontier reindex hook. Today this writes a marker at
 * <stateDir>/reindex-pending and appends the entry path on a new line.
 * The next session's --incremental reindex (ships with the SQLite
 * follow-up) reads the marker, processes the queued entries, then
 * truncates the file.
 */
function enqueueFrontierReindexFile(stateDir, entryPath) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const marker = join(stateDir, "reindex-pending");
    let body = "";
    if (existsSync(marker)) body = readFileSync(marker, "utf8");
    if (!body.endsWith("\n") && body.length > 0) body += "\n";
    body += entryPath + "\n";
    writeFileSync(marker, body);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
