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

import { existsSync, mkdirSync, readFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteTextSync } from "../fsx.mjs";
import { serialiseEntry } from "./frontmatter.mjs";
import { validateEntry } from "./validate.mjs";
import { query as queryEntries } from "./query.mjs";

// Sync atomic write contract is owned by scripts/lib/fsx.mjs::
// atomicWriteTextSync — same write-to-temp + rename + cleanup-on-failure
// shape as the async atomicWriteText, just with sync fs calls. writeEntry
// stays sync because the surrounding 4-step sequence (spawnSync into
// skill-llm-wiki, sync filesystem ops, sync frontier marker append) is
// sync end-to-end. rename(2) is atomic-replace on POSIX/NTFS but does
// NOT fsync the file contents or the containing directory; the contract
// is "no half-written leaf is ever visible at <slug>.md", which is
// exactly what atomic rename guarantees.

/**
 * Write one knowledge entry through the atomic 4-step sequence.
 *
 * @param {object} args
 * @param {string} args.wikiRoot       absolute path to the configured wiki root (typically `wiki.roots.shared`)
 * @param {string} args.domain         domain slug under knowledge/ (e.g. "patterns", "incidents")
 * @param {string} args.slug           entry slug (matches data.id; written as <slug>.md)
 * @param {object} args.data           frontmatter object; full schema fields required
 * @param {string} args.body           markdown body. The serialiser
 *                                     (frontmatter.mjs::serialiseEntry)
 *                                     prepends a leading newline if
 *                                     missing AND ensures a trailing
 *                                     newline; it does NOT modify any
 *                                     other byte. Most callers pass
 *                                     prose that already starts with
 *                                     content (no leading newline) and
 *                                     ends with one trailing `\n`, so
 *                                     the normalisation is a no-op in
 *                                     practice.
 * @param {string} [args.stateDir]     absolute path to project .claude/state (for the reindex-pending marker)
 * @param {object} [_deps]             test injection seam
 * @returns {{ ok: true, path: string, warnings: string[] } | { ok: false, error: string, step: number }}
 */
export function writeEntry(args, _deps = {}) {
  const { wikiRoot, domain, slug, data, body } = args;
  if (!isNonEmptyString(wikiRoot)) return fail(0, "writeEntry: wikiRoot is required");
  // Domain must look like a real slug: lowercase alnum + hyphen +
  // underscore, starting with a letter. Whitespace, dots, slashes,
  // and other path-traversal-adjacent shapes all fail. Without the
  // tighter pattern, values like `" "`, `"my domain"`, or
  // `"patterns "` would create unexpected directories under
  // <wikiRoot>/knowledge/ and defeat the "domain slug" assumption.
  if (typeof domain !== "string" || !/^[a-z][a-z0-9_-]*$/.test(domain))
    return fail(0, `writeEntry: invalid domain ${JSON.stringify(domain)} (must match /^[a-z][a-z0-9_-]*$/)`);
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

  // Step 0 — global id uniqueness. The schema enforces single-segment
  // kebab-case ids (no `/`), so the on-disk path encodes the domain
  // but the `data.id` does not. That means an entry at
  // knowledge/patterns/foo.md and another at knowledge/incidents/foo.md
  // would share id "foo", and read-side getEntryById would have to
  // pick a winner arbitrarily. Fail-fast at write time when this
  // collision would be created. Existing-at-the-same-path is fine —
  // that is an UPDATE, not a collision; we only reject when the same
  // id already exists at a DIFFERENT path under <wikiRoot>/knowledge/.
  const existingMatches = _deps.findExistingById
    ? _deps.findExistingById(wikiRoot, slug)
    : findExistingById(wikiRoot, slug);
  const collisions = existingMatches.filter((p) => p !== path);
  if (collisions.length > 0) {
    return fail(
      0,
      `writeEntry: id "${slug}" already exists under <wikiRoot>/knowledge at: ${collisions.join(", ")}. Pick a different slug, rename the existing entry, or delete the stale copy first.`,
    );
  }

  // Snapshot the prior file contents before the atomic write so a
  // rollback on a same-path UPDATE can restore the previous version.
  // Without this, a step-2/3 failure on an update would delete the
  // user's existing entry — silent data loss. For brand-new writes
  // (file does not exist yet), `priorContent` stays null and rollback
  // falls back to deleting the leaf.
  let priorContent = null;
  if (existsSync(path)) {
    try {
      priorContent = readFileSync(path, "utf8");
    } catch (err) {
      return fail(1, `step 1 (snapshot prior content for rollback): ${err?.message ?? String(err)}`);
    }
  }

  // Step 1 — write markdown atomically (write-to-temp + rename). A
  // crash/kill mid-write must NEVER leave a truncated leaf in the wiki
  // tree; if it did, the next skill-llm-wiki validate would either
  // accept the corrupted file (silent rot) or fail and require manual
  // cleanup. atomicWriteTextSync handles parent-dir creation + temp
  // file naming + rename + cleanup-on-failure in one place, shared
  // with the rest of the bundle's writer surface.
  try {
    atomicWriteTextSync(path, serialiseEntry(data, body));
  } catch (err) {
    return fail(1, `step 1 (write markdown): ${err?.message ?? String(err)}`);
  }

  // Step 2a — local frontmatter schema check. Wrap in try/catch so an
  // internal failure (schema file missing, ajv compile error, an
  // injected test validator throwing) is treated as a step-2 failure
  // and triggers rollback. Without the catch, the throw would
  // propagate up to the caller AFTER step 1 already wrote the file,
  // leaving the leaf on disk and violating the atomic contract.
  let local;
  try {
    local = validateFn(data, path);
  } catch (err) {
    const rb = rollback(path, priorContent);
    return fail(
      2,
      appendRollbackError(
        `step 2 (local frontmatter validation): validator threw: ${err?.message ?? String(err)}`,
        rb,
        path,
      ),
    );
  }
  if (!local.ok) {
    const rb = rollback(path, priorContent);
    return fail(
      2,
      appendRollbackError(`step 2 (local frontmatter validation): ${local.errors.join("; ")}`, rb, path),
    );
  }

  // Step 2b — skill-llm-wiki validate (full tree). The wiki layer
  // catches dangling parents, id-vs-filename mismatches we already
  // caught locally, depth-role rules, and slug uniqueness. Wrap in
  // try/catch so a synchronous throw from the runner (default CLI
  // spawn or an injected stub) is converted into a step-2 failure
  // and triggers rollback. Without the catch, the throw would
  // propagate up AFTER step 1 wrote the leaf, violating the atomic
  // contract.
  let wikiResult;
  try {
    wikiResult = runWikiValidate(wikiRoot);
  } catch (err) {
    wikiResult = { ok: false, error: `runner threw: ${err?.message ?? String(err)}` };
  }
  if (!wikiResult.ok) {
    const rb = rollback(path, priorContent);
    return fail(
      2,
      appendRollbackError(`step 2 (skill-llm-wiki validate): ${wikiResult.error}`, rb, path),
    );
  }

  // Step 3 — index rebuild for the parent chain. Until
  // ctxr-dev/skill-llm-wiki#16 lands `--scope`, the runner falls back
  // to full-tree rebuild and surfaces a warning. Same try/catch
  // guard as step 2b: a synchronous throw must NOT bypass the
  // rollback path.
  let rebuildResult;
  try {
    rebuildResult = runRebuild(wikiRoot, dir);
  } catch (err) {
    rebuildResult = { ok: false, error: `runner threw: ${err?.message ?? String(err)}` };
  }
  if (!rebuildResult.ok) {
    // Rollback contract: a step-3 failure can occur AFTER the rebuilder
    // has partially updated index.md siblings (cluster / domain
    // indexes) to reference the new leaf. Just deleting the leaf at
    // <slug>.md would leave those index.md edits dangling, so the wiki
    // would still surface a stale entry pointing at a now-missing
    // file. Restore consistency by running a FULL-tree rebuild AFTER
    // removing the leaf: `fullTree: true` skips the scoped attempt so
    // a partial index update is always overwritten against the live
    // tree, regardless of which form failed in the original rebuild.
    // If the reconcile rebuild also fails, the wiki really is
    // inconsistent; surface both errors so ops sees the full picture.
    // The reconcile call gets the same try/catch guard so a
    // synchronous throw still produces a deterministic
    // {ok:false, step:3, ...} result.
    const rb = rollback(path, priorContent);
    let reconcile;
    try {
      reconcile = runRebuild(wikiRoot, dir, { fullTree: true });
    } catch (err) {
      reconcile = { ok: false, error: `runner threw: ${err?.message ?? String(err)}` };
    }
    if (!reconcile.ok) {
      return fail(
        3,
        appendRollbackError(
          `step 3 (index-rebuild): ${rebuildResult.error}; reconcile after leaf rollback also failed: ${reconcile.error}. Wiki indexes may be inconsistent; run \`skill-llm-wiki index-rebuild ${wikiRoot}\` manually.`,
          rb,
          path,
        ),
      );
    }
    return fail(
      3,
      appendRollbackError(
        `step 3 (index-rebuild): ${rebuildResult.error} (leaf removed; indexes reconciled)`,
        rb,
        path,
      ),
    );
  }
  if (rebuildResult.scoped === false) {
    warnings.push(
      "skill-llm-wiki index-rebuild ran in full-tree mode; the chain-scoped variant lands in skill-llm-wiki#16. Latency is fine for small trees; revisit when the dep merges.",
    );
  }

  // Step 4 — SQLite frontier reindex. STUB until the follow-up PR adds
  // the actual sqlite writer. We write a marker so the next session-
  // start `--incremental` reindex can fast-forward. Best-effort: a
  // failure here is a SOFT warning (the wiki itself is already
  // consistent), so the call goes through try/catch — the injected
  // dependency or a future implementation throwing synchronously
  // must NOT break the soft-warning contract by propagating up to
  // the caller as a hard failure.
  if (isNonEmptyString(args.stateDir)) {
    let enq;
    try {
      enq = enqueueReindex(args.stateDir, path);
    } catch (err) {
      enq = { ok: false, error: `marker write threw: ${err?.message ?? String(err)}` };
    }
    if (!enq.ok) {
      warnings.push(`step 4 (frontier reindex): ${enq.error} (marker not written; the next session-start reindex must walk the wiki to recover)`);
    }
  }

  return { ok: true, path, warnings };
}

// ---------- internals ----------

function isNonEmptyString(s) {
  // Trim before measuring length: a whitespace-only wikiRoot or
  // stateDir would otherwise resolve to some unexpected path
  // (e.g. cwd + "   " collapsing to cwd) and writes would land
  // outside the intended tree. The full wikiRoot / stateDir
  // arguments are paths, so trim-then-empty is a clean reject.
  return typeof s === "string" && s.trim().length > 0;
}

function fail(step, error) {
  return { ok: false, step, error };
}

function rollback(path, priorContent) {
  // Two cases:
  //   priorContent === null  — this was a brand-new write (no file at
  //                            `path` before step 1). Delete the leaf
  //                            so the tree returns to its pre-write
  //                            state.
  //   priorContent  is a string — this was an UPDATE. The atomic
  //                            rename in step 1 has already replaced
  //                            the previous version on disk. Restore
  //                            the snapshot via atomicWriteTextSync
  //                            so a step-2/3 failure does not turn
  //                            into silent data loss.
  // Returns { ok: true } when the rollback succeeded, or
  // { ok: false, error: <message> } when it failed (e.g. Windows file
  // lock, permission denied). The caller is expected to append the
  // rollback error to the step-failure message so an admin sees the
  // wiki-may-be-inconsistent warning instead of a silent half-state.
  try {
    if (priorContent == null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      atomicWriteTextSync(path, priorContent);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Helper: append a rollback failure note to a step-failure error so
// callers do not have to copy the same boilerplate at every site.
function appendRollbackError(stepError, rollbackResult, path) {
  if (!rollbackResult || rollbackResult.ok) return stepError;
  return `${stepError}; rollback ALSO failed (${rollbackResult.error}) — leaf at ${path} may be inconsistent. Inspect by hand.`;
}

/**
 * Walk <wikiRoot>/knowledge/ and return every leaf path whose
 * frontmatter `id` matches the supplied slug. Used by writeEntry's
 * step-0 collision check. The default implementation defers to
 * query.mjs::query, which uses the same in-process tree fingerprint
 * as enumerateEntries, so adjacent writeEntry calls in the same
 * process see fresh state without manual cache invalidation. Tests
 * can inject a stub via _deps.findExistingById.
 */
function findExistingById(wikiRoot, id) {
  // includeArchived: true is load-bearing for the step-0 collision
  // gate. The default query semantics exclude status:"archived" so
  // archived entries do not pollute routing — but for collision
  // detection we MUST see them. Otherwise an entry archived under one
  // domain (kept for history) would silently allow a duplicate id
  // under a different domain, and getEntryById would then throw
  // DuplicateEntryIdError on every subsequent lookup. Surface the
  // collision at write time when it is still cheap to fix.
  return queryEntries(wikiRoot, { id, includeArchived: true }).map((m) => m.path);
}

/**
 * Default CLI runner for `skill-llm-wiki validate`. Resolves the
 * binary as `skill-llm-wiki` on PATH; tests inject a stub via _deps.
 */
function runSkillLlmWikiCli(wikiRoot) {
  // shell:true on win32 is the bundle convention (see scripts/update_self.mjs
  // and scripts/lib/ghExec.mjs): without it, spawnSync cannot resolve
  // `.cmd` shims that npm-installed CLIs land as on Windows, and the
  // call fails with ENOENT before reaching the binary. POSIX runs
  // spawnSync directly without a shell.
  const result = spawnSync("skill-llm-wiki", ["validate", wikiRoot], {
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
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
 *
 * @param {string} wikiRoot
 * @param {string} leafDir
 * @param {{ fullTree?: boolean }} [opts] when fullTree is true, the
 *        scoped attempt is SKIPPED and the runner goes directly to the
 *        full-tree call. Used by writeEntry's step-3 reconcile path so
 *        an index.md half-write made by the failed scoped rebuild is
 *        always rewritten against the live tree.
 */
function runIndexRebuildCli(wikiRoot, leafDir, opts = {}) {
  if (opts.fullTree === true) {
    return runFullTreeRebuild(wikiRoot);
  }
  // Attempt scoped rebuild first. Once skill-llm-wiki#16 lands this is
  // O(depth) and finishes in well under a second on real trees.
  const scoped = spawnSync("skill-llm-wiki", ["index-rebuild", wikiRoot, "--scope", leafDir], {
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
  });
  if (!scoped.error && scoped.status === 0) {
    return { ok: true, scoped: true };
  }
  // If scoped failed because the flag isn't supported yet (the dep at
  // skill-llm-wiki#16 hasn't landed), fall back to full-tree rebuild.
  // Any OTHER failure (timeout, real validation failure, spawn errors
  // unrelated to flag parsing) propagates as-is so a real bug isn't
  // masked by the fallback.
  //
  // The ENOENT case (the binary itself isn't on PATH) is fatal AND
  // independent of the flag — surface that first; the full-rebuild
  // call would just hit the same ENOENT.
  if (scoped.error && scoped.error.code === "ENOENT") {
    return { ok: false, error: `spawn failed: ${scoped.error.message}` };
  }
  const stderrLower = (scoped.stderr || "").toLowerCase();
  // Tightened: only treat the failure as "unknown flag" when stderr
  // explicitly mentions BOTH that the flag is unknown / unrecognised
  // AND that it's the --scope flag specifically. The previous
  // "usage:" / bare "scope" matches were too broad and would
  // misclassify a real scoped-rebuild failure (e.g. a partial-tree
  // assertion that mentions "scope" in its message) as a flag-unknown
  // case, silently falling back to a full-tree rebuild and masking
  // the genuine error. After skill-llm-wiki#16 lands the scoped
  // form, this whole branch becomes dead code; we keep it tight in
  // the meantime.
  const looksUnknown =
    stderrLower.includes("unknown") ||
    stderrLower.includes("unrecognised") ||
    stderrLower.includes("unrecognized");
  const mentionsScope =
    stderrLower.includes("--scope") || stderrLower.includes("'scope'") || stderrLower.includes("`scope`");
  const flagUnknown = looksUnknown && mentionsScope;
  if (!flagUnknown) {
    if (scoped.error) {
      return { ok: false, error: `spawn failed: ${scoped.error.message}` };
    }
    return { ok: false, error: (scoped.stderr || scoped.stdout || `exit ${scoped.status}`).trim() };
  }
  // Fall back to full rebuild.
  return runFullTreeRebuild(wikiRoot);
}

function runFullTreeRebuild(wikiRoot) {
  const full = spawnSync("skill-llm-wiki", ["index-rebuild", wikiRoot], {
    encoding: "utf8",
    timeout: 60_000,
    shell: process.platform === "win32",
  });
  if (full.error) return { ok: false, error: `spawn failed: ${full.error.message}` };
  if (full.status !== 0) return { ok: false, error: (full.stderr || full.stdout || `exit ${full.status}`).trim() };
  return { ok: true, scoped: false };
}

/**
 * Default frontier reindex hook. Appends the entry path as a new line
 * to <stateDir>/reindex-pending. The next session's --incremental
 * reindex (ships with the SQLite follow-up) reads the marker,
 * processes the queued entries, then truncates the file.
 *
 * Uses appendFileSync (which opens with O_APPEND on POSIX, atomically
 * appending each call's bytes). Two concurrent writeEntry() calls
 * each emit one self-contained line; their writes interleave at line
 * granularity but never overwrite each other. This is the standard
 * pattern for low-volume append-only logs.
 */
function enqueueFrontierReindexFile(stateDir, entryPath) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const marker = join(stateDir, "reindex-pending");
    appendFileSync(marker, entryPath + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
