#!/usr/bin/env node
// install.mjs
// One-command installer for the agent-staff-engineer bundle.
//
// Flow:
//   1. preflight (Node version)
//   2. sanity: bundle present at <target>/.claude/agents/agent-staff-engineer/
//   3. bundle schema self-check (example config validates)
//   4. bootstrap (if ops.config.json missing) OR load existing ops.config.json
//   5. CLAUDE.md render (wrapper pointing at bundle rules)
//   6. ensure <target>/.development/ exists with shared/ (committed),
//      local/ (gitignored), and cache/ (gitignored) subtrees;
//      append local/ + cache/ paths to .gitignore when enabled
//   7. generate SKILL wrappers at paths.wrappers.skills_dir
//   8. generate RULE wrappers at paths.wrappers.rules_dir (exclude product-*.md)
//   9. call install_memory_seeds.mjs to generate memory wrappers
//  10. write <target>/.claude/.<scoped-agent-slug>-install-manifest.json
//      (e.g. `.ctxr-agent-staff-engineer-install-manifest.json`); a legacy
//      generic `.install-manifest.json` from a pre-rename install is read
//      once and then removed so only one manifest remains.
//  11. summary report
//
// Update mode:
//   - Same passes, but existing wrappers are preserved below their marker;
//     above-marker section is regenerated from the current bundle state.
//
// Uninstall mode:
//   - Read manifest, remove each wrapper. Preserve wrappers whose below-marker
//     section contains user text (rename to *.userkeep.md).
//

import { readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { preflight } from "./preflight.mjs";
import { parseArgv, boolFlag } from "./lib/argv.mjs";
import {
  atomicWriteText,
  atomicWriteJson,
  ensureDir,
  isDirectory,
  readJsonOrNull,
  readTextOrNull,
  safeRealpathOrExit,
  sha256,
} from "./lib/fsx.mjs";
import { validate } from "./lib/schema.mjs";
import { mergeWrapper } from "./lib/wrapper.mjs";
import { ensureGitignore } from "./lib/gitignore.mjs";
import { injectManagedBlock, removeManagedBlock } from "./lib/inject.mjs";
import { getAgentPrefix, prefixed } from "./lib/agentName.mjs";
import { portableRef, resolvePortable } from "./lib/bundleRef.mjs";

// Managed-block markers used to own a region inside a project-authored
// CLAUDE.md. Any content outside these two lines belongs to the user and the
// installer must never touch it. Marker strings are deliberately long and
// distinctive so they do not collide with natural prose.
const CLAUDE_MD_BEGIN_MARKER =
  "<!-- agent-staff-engineer:begin managed block (do not edit between markers; regenerated on install.mjs --update; see the CLAUDE.md managed-block section in <bundle>/INSTALL.md) -->";
const CLAUDE_MD_END_MARKER =
  "<!-- agent-staff-engineer:end managed block (edits below this line are preserved across installs) -->";

// Parse args BEFORE preflight so --help runs even when Node is too old (it
// otherwise fails silently for a user who cannot yet install Node).
const { flags } = parseArgv(process.argv.slice(2), {
  booleans: new Set(["dry-run", "apply", "update", "uninstall", "yes", "help", "auto-install-node"]),
});
if (flags.help) {
  printHelp();
  process.exit(0);
}

// Preflight after --help. Pass through --auto-install-node on the first attempt
// (avoids a double-preflight on the common fast path).
await preflight({ autoInstall: boolFlag(flags, "auto-install-node", false) });

// Location awareness: the bundle lives wherever kit (or the user) placed it.
// We self-locate from the script's own URL; BUNDLE_ABS is wherever this file
// sits plus one level up. BUNDLE_REF expresses that path in a form that is
// safe to commit: project-relative when the bundle lives inside TARGET,
// "~/..." when the bundle lives under $HOME (user-global kit install at
// ~/.claude/), or absolute as a last resort. See lib/bundleRef.mjs.
// Resolve both paths through realpath so symlinked parents (common: /tmp vs
// /private/tmp on macOS) do not foul the inside-TARGET check below.
const BUNDLE_ABS_NAIVE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ABS = await safeRealpathOrExit(BUNDLE_ABS_NAIVE, "bundle");
const TARGET_NAIVE = resolve(flags.target ?? ".");
const TARGET = await safeRealpathOrExit(TARGET_NAIVE, "target");
const MODE =
  boolFlag(flags, "uninstall", false)
    ? "uninstall"
    : boolFlag(flags, "update", false)
    ? "update"
    : boolFlag(flags, "apply", false)
    ? "apply"
    : "dry-run";
const YES = boolFlag(flags, "yes", false);

const BUNDLE_REF = portableRef(BUNDLE_ABS, TARGET);
// State (manifest + bootstrap answers) lives under the TARGET project, not inside
// the bundle. Reasons:
//   (a) user-global kit installs place the bundle under ~/.claude/... which may
//       be read-only or shared across projects;
//   (b) two projects that share a user-global bundle must not overwrite each
//       other's install manifest;
//   (c) the state is project-specific by nature.
// `.claude/` is always writable inside the user's project.
const STATE_DIR = join(TARGET, ".claude");

// Agent-scoped manifest name so two agents installed into the same target
// (e.g. `@ctxr/agent-staff-engineer` and a sibling agent) keep independent
// install state. The slug is the package name with the leading `@` stripped
// and `/` replaced by `-`.
//
// The installer writes only to MANIFEST_PATH. On read we also accept the
// legacy generic name `.install-manifest.json` for back-compat with installs
// made before the per-agent rename; the legacy file is removed at the end
// of a successful `--apply`/`--update` so only one manifest remains on disk.
const { prefix: AGENT_PREFIX, scopedSlug: AGENT_SCOPED_SLUG } =
  await getAgentPrefix(BUNDLE_ABS);
const MANIFEST_PATH = join(STATE_DIR, `.${AGENT_SCOPED_SLUG}-install-manifest.json`);
const LEGACY_MANIFEST_PATH = join(STATE_DIR, ".install-manifest.json");

async function readManifestJson() {
  const current = await readJsonOrNull(MANIFEST_PATH);
  if (current) return { manifest: current, path: MANIFEST_PATH, legacy: false };
  const legacy = await readJsonOrNull(LEGACY_MANIFEST_PATH);
  if (legacy) return { manifest: legacy, path: LEGACY_MANIFEST_PATH, legacy: true };
  return { manifest: null, path: null, legacy: false };
}

/** Current ops.config.json contents, populated once we load or bootstrap it. */
let opsConfig = null;

process.stdout.write(`\nagent-staff-engineer / install.mjs\n`);
process.stdout.write(`target: ${TARGET}\n`);
process.stdout.write(`mode:   ${MODE}\n\n`);

// Note: safeRealpath already handled the "bundle not found" path with a
// friendly error. By this point BUNDLE_ABS is guaranteed to exist.

if (MODE === "uninstall") {
  // Uninstall needs the marker from ops.config.json (or the default if the
  // config is already gone). Load it before calling runUninstall so the
  // helper never runs against an uninitialised `opsConfig`.
  opsConfig = await readJsonOrNull(join(TARGET, ".claude/ops.config.json"));
  await runUninstall({ dryRun: boolFlag(flags, "dry-run", false) });
  process.exit(0);
}

// Bundle schema self-check.
{
  const schemaPath = join(BUNDLE_ABS, "schemas/ops.config.schema.json");
  const examplePath = join(BUNDLE_ABS, "examples/ops.config.example.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const example = JSON.parse(await readFile(examplePath, "utf8"));
  const v = validate(schema, example);
  if (!v.ok) {
    process.stderr.write("bundle schema self-check FAILED:\n");
    for (const e of v.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.exit(1);
  }
}

// Load or bootstrap ops.config.json.
const opsConfigPath = join(TARGET, ".claude/ops.config.json");
opsConfig = await readJsonOrNull(opsConfigPath);
if (!opsConfig) {
  process.stdout.write("no ops.config.json yet; running bootstrap.mjs\n\n");
  // Use the ABSOLUTE path to bootstrap.mjs so this works regardless of
  // whether the bundle is inside TARGET or placed at a user-global location.
  // The previous relative path `scripts/bootstrap.mjs` silently failed on
  // user-global installs because `cwd: TARGET` has no such relative script.
  const bootstrapScript = join(BUNDLE_ABS, "scripts", "bootstrap.mjs");
  const args = [bootstrapScript, "--target", TARGET];
  if (MODE === "apply" || MODE === "update") args.push("--apply");
  if (YES) args.push("--yes");
  if (boolFlag(flags, "auto-install-node", false)) args.push("--auto-install-node");
  const res = spawnSync(process.execPath, args, {
    stdio: "inherit",
    cwd: TARGET,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    process.stderr.write(`\nbootstrap failed (exit ${res.status}); aborting install.\n`);
    process.exit(res.status ?? 1);
  }
  opsConfig = await readJsonOrNull(opsConfigPath);
  if (!opsConfig && MODE !== "apply") {
    process.stdout.write("\n(dry-run) bootstrap ran without writing. Re-run install --apply to continue.\n");
    process.exit(0);
  }
  if (!opsConfig) {
    process.stderr.write("bootstrap did not produce an ops.config.json. aborting.\n");
    process.exit(1);
  }
}

// Dependency check: the LLM-wiki provider skill must be present before the
// installer can proceed when ops.config declares the wiki as required. This
// runs after bootstrap so a fresh install has a real opsConfig to read.
// See rules/llm-wiki.md for the runtime contract this gate protects.
if (opsConfig.wiki?.required) {
  const provider = opsConfig.wiki.provider ?? "@ctxr/skill-llm-wiki";
  const found = locateKitSkill(provider, TARGET);
  if (!found) {
    process.stderr.write(
      `\nERROR: agent-staff-engineer requires the wiki provider skill '${provider}'.\n` +
      `It was not found at either\n` +
      `  ${kitSkillCandidatePaths(provider, TARGET).join("\n  ")}\n\n` +
      `Install it first:\n` +
      `  npx @ctxr/kit install ${provider}\n\n` +
      `Then re-run this installer. To opt out (you will manage .development/ manually),\n` +
      `set 'wiki.required' to false in ops.config.json.\n`
    );
    process.exit(1);
  }
  process.stdout.write(`wiki provider: ${provider} found at ${portableRef(found, TARGET)}\n`);
}

const marker = opsConfig.paths.wrappers.marker;
const headerNotice = opsConfig.paths.wrappers.header_notice;
const skillsDir = resolve(TARGET, opsConfig.paths.wrappers.skills_dir);
const rulesDir = resolve(TARGET, opsConfig.paths.wrappers.rules_dir);
const devWorkingDir = resolve(TARGET, opsConfig.paths.dev_working_dir);
const sharedSub = opsConfig.paths.dev_working_shared_subdir ?? "shared";
const localSub = opsConfig.paths.dev_working_local_subdir ?? "local";
const cacheSub = opsConfig.paths.dev_working_cache_subdir ?? "cache";

// Derive the wrapper-filename prefix ONCE, from package.json. Used below to
// AGENT_PREFIX was resolved earlier (needed for the manifest filename); it
// also prefixes every file the installer writes into the target project so
// wrappers do not collide with those from other agents/skills.

// Plan writes.
const writes = [];
const manifestEntries = [];

// 1. Skill wrappers.
const skillNames = (await readdir(join(BUNDLE_ABS, "skills"), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
for (const name of skillNames) {
  const canonicalRel = `${BUNDLE_REF}/skills/${name}/SKILL.md`;
  // Wrapper folder is prefixed to avoid clashes with skills from other agents
  // that might register an identically-named short skill in the same target.
  const targetPath = join(skillsDir, prefixed(AGENT_PREFIX, name), "SKILL.md");
  const existing = await readTextOrNull(targetPath);
  const above = buildSkillAbove(name, canonicalRel, headerNotice);
  const content = mergeWrapper(existing, above, marker);
  writes.push({
    action: existing == null ? "create" : "refresh-above-marker",
    path: targetPath,
    content,
    meta: { kind: "skill", canonical: canonicalRel, sha: sha256(content) },
  });
}

// 2. Rule wrappers (skip product-*.md; those are project-specific, not in bundle).
const ruleFiles = (await readdir(join(BUNDLE_ABS, "rules"), { withFileTypes: true }))
  .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("product-"))
  .map((e) => e.name);
for (const file of ruleFiles) {
  const name = file.replace(/\.md$/, "");
  const canonicalRel = `${BUNDLE_REF}/rules/${file}`;
  // Rule wrappers are prefixed so they cannot collide with rules of the same
  // short name shipped by a different agent or skill (e.g. "pr-workflow.md").
  const targetPath = join(rulesDir, `${prefixed(AGENT_PREFIX, name)}.md`);
  const existing = await readTextOrNull(targetPath);
  const above = buildRuleAbove(name, canonicalRel, headerNotice);
  const content = mergeWrapper(existing, above, marker);
  writes.push({
    action: existing == null ? "create" : "refresh-above-marker",
    path: targetPath,
    content,
    meta: { kind: "rule", canonical: canonicalRel, sha: sha256(content) },
  });
}

// 3. CLAUDE.md managed-block injection at project root.
//    Behaviour:
//      * No CLAUDE.md → create one with a short preamble + the managed block.
//      * CLAUDE.md exists, no managed block → append the block at the end,
//        preserving every byte of the user's existing content.
//      * CLAUDE.md exists with a managed block → replace only the content
//        between the two markers. Everything outside is byte-for-byte intact.
//    The `injectManagedBlock` helper (scripts/lib/inject.mjs) owns the math
//    and is covered by unit tests.
{
  const targetPath = join(TARGET, "CLAUDE.md");
  // Refuse cleanly if CLAUDE.md is somehow a directory — readTextOrNull now
  // swallows EISDIR and returns null, so we explicitly detect it and write a
  // helpful error instead of silently creating a new file on top.
  if (await isDirectory(targetPath)) {
    process.stderr.write(
      `install: ${targetPath} is a directory. Remove or rename it before running install --apply.\n`
    );
    process.exit(1);
  }
  const existing = await readTextOrNull(targetPath);
  const managed = buildClaudeMdManagedBlock(opsConfig, AGENT_PREFIX);
  let content;
  try {
    // Do NOT add a preamble when creating the file from scratch. The managed
    // block is entirely self-contained, and keeping it that way means
    // --uninstall can cleanly remove the file we created without leaving a
    // naked "# Project CLAUDE.md" behind.
    content = injectManagedBlock(existing, managed, {
      begin: CLAUDE_MD_BEGIN_MARKER,
      end: CLAUDE_MD_END_MARKER,
    });
  } catch (err) {
    process.stderr.write(
      `install: CLAUDE.md injection refused (${err.message}). Skipping.\n` +
        `Fix the marker pair in ${targetPath} and re-run --update, or delete the file.\n`
    );
    content = null;
  }
  if (content != null) {
    writes.push({
      action: existing == null ? "create" : "inject-managed-block",
      path: targetPath,
      content,
      meta: { kind: "project-claude-md", canonical: null, sha: sha256(content) },
    });
  }
}

// Orphan detection: walk existing manifest and flag wrappers whose canonical
// is no longer present in the bundle. Manifest paths are portable (project-
// relative or "~/..."); resolve them back to absolute so the comparison and
// any subsequent filesystem ops operate on real paths on this machine.
const { manifest: existingManifest } = await readManifestJson();
if (existingManifest && Array.isArray(existingManifest.wrappers)) {
  const currentSet = new Set(writes.map((w) => w.path));
  for (const entry of existingManifest.wrappers) {
    const abs = resolvePortable(entry.path, TARGET);
    if (!currentSet.has(abs)) {
      writes.push({
        action: "orphan-flag (canonical removed)",
        path: abs,
        content: null,
        warn: true,
        meta: entry,
      });
    }
  }
}

// Print plan.
for (const w of writes) {
  const shaTag = w.meta?.sha ? ` sha=${w.meta.sha.slice(0, 8)}` : "";
  process.stdout.write(
    `  ${w.action.padEnd(28)} ${relative(TARGET, w.path)}${shaTag}${w.warn ? " !warn" : ""}\n`
  );
}
if (MODE === "dry-run") {
  process.stdout.write(
    `\n(dry-run) ${writes.filter((w) => w.content != null).length} wrapper(s) would be written. Re-run with --apply or --update.\n`
  );
  process.exit(0);
}

// Apply.
// Create the three-way split under the dev working dir:
//   shared/  committed (team configs, reports, runbooks)
//   local/   gitignored (per-user artefacts)
//   cache/   gitignored (regenerable scratch)
// The shared subtree intentionally stays OUT of .gitignore so team conventions
// commit with the project.
await ensureDir(devWorkingDir);
await ensureDir(resolve(devWorkingDir, sharedSub));
await ensureDir(resolve(devWorkingDir, localSub));
await ensureDir(resolve(devWorkingDir, cacheSub));

// Pre-seed the standard topic folders under shared/. Each topic folder is
// its own in-place LLM wiki managed by the provider skill; the agent
// initialises a topic (`skill-llm-wiki build --layout-mode in-place`) the
// first time it writes into one. The installer only guarantees the empty
// folders exist so writers know where to land without guessing.
const wikiSharedTopics = Array.isArray(opsConfig.wiki?.shared_topics)
  ? opsConfig.wiki.shared_topics
  : ["runbooks", "reports", "plans"];
for (const topic of wikiSharedTopics) {
  await ensureDir(resolve(devWorkingDir, sharedSub, topic));
}

// Drop a short README under the shared subtree so first-time readers know
// which folder commits, which does not, and how the LLM wiki layer works.
const sharedReadmePath = resolve(devWorkingDir, sharedSub, "README.md");
if (!(await readTextOrNull(sharedReadmePath))) {
  const wikiProvider = opsConfig.wiki?.provider ?? "@ctxr/skill-llm-wiki";
  await atomicWriteText(
    sharedReadmePath,
    [
      `# ${opsConfig.paths.dev_working_dir}/${sharedSub}`,
      "",
      `This folder is committed with the project. Every topical subfolder here is its own in-place LLM wiki managed by \`${wikiProvider}\`:`,
      "",
      ...wikiSharedTopics.map((t) => `- \`${t}/\`: ${topicBlurb(t)}`),
      "",
      `The agent does not write raw markdown into these folders directly. It goes through the provider skill so each doc is placed, front-mattered, and indexed for retrieval. See \`.claude/rules/${AGENT_PREFIX}_llm-wiki.md\` for the read/write contract and \`${wikiProvider}\`'s own SKILL.md for the canonical wiki format.`,
      "",
      `Anything user-specific goes under \`../${localSub}/\` (gitignored); regenerable scratch goes under \`../${cacheSub}/\` (gitignored). Those two scopes also use the wiki layer when the agent writes into them.`,
      "",
    ].join("\n")
  );
}

if (opsConfig.paths.gitignore_dev_working_dir !== false) {
  await ensureGitignore(TARGET, [
    `${opsConfig.paths.dev_working_dir}/${localSub}`,
    `${opsConfig.paths.dev_working_dir}/${cacheSub}`,
  ]);
}
for (const w of writes) {
  if (w.content == null) continue;
  await ensureDir(dirname(w.path));
  await atomicWriteText(w.path, w.content);
  if (w.meta?.canonical) {
    manifestEntries.push({
      path: portableRef(w.path, TARGET),
      kind: w.meta.kind,
      canonical: w.meta.canonical,
      sha: w.meta.sha,
      written_at: new Date().toISOString(),
    });
  } else if (w.meta) {
    manifestEntries.push({
      path: portableRef(w.path, TARGET),
      kind: w.meta.kind,
      written_at: new Date().toISOString(),
      sha: w.meta.sha,
    });
  }
}

// Memory seeds via the dedicated script. We capture its stdout so that any
// __MANIFEST__ lines it prints (via --emit-manifest) get folded into our
// wrapper manifest. That way `--uninstall` can clean up memory wrappers too.
{
  const seedInstaller = join(BUNDLE_ABS, "scripts", "install_memory_seeds.mjs");
  const args = [
    seedInstaller,
    "--target",
    TARGET,
    MODE === "update" ? "--update" : "--apply",
    "--emit-manifest",
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: TARGET,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Forward the human-readable progress.
  if (res.stdout) {
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("__MANIFEST__ ")) {
        try {
          const entry = JSON.parse(line.slice("__MANIFEST__ ".length));
          manifestEntries.push(entry);
        } catch {
          /* ignore bad line */
        }
      } else if (line.length > 0) {
        process.stdout.write(line + "\n");
      }
    }
  }
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    process.stderr.write(`\nmemory seed install failed (exit ${res.status}).\n`);
    // continue to write manifest for wrappers already applied
  }
}

// Manifest.
const manifest = {
  version: "0.1.0",
  bundle_root: BUNDLE_REF,
  installed_at: new Date().toISOString(),
  wrappers: manifestEntries,
};
await atomicWriteJson(MANIFEST_PATH, manifest);

// Retire a legacy generic manifest from a pre-rename install if one exists.
// The new agent-scoped manifest is now canonical; leaving the legacy file in
// place would let two files drift. Only remove after a successful write.
if (await readJsonOrNull(LEGACY_MANIFEST_PATH)) {
  await rm(LEGACY_MANIFEST_PATH, { force: true });
  process.stdout.write(
    `migrated legacy manifest: ${relative(TARGET, LEGACY_MANIFEST_PATH)} -> ${relative(TARGET, MANIFEST_PATH)}\n`
  );
}

process.stdout.write(
  `\ninstall ${MODE} complete. manifest at ${relative(TARGET, MANIFEST_PATH)}.\n`
);

// ---- Helpers ------------------------------------------------------------

/** Short human blurb for the conventional topic wikis seeded under shared/. */
function topicBlurb(topic) {
  switch (topic) {
    case "runbooks": return "team runbooks (incident, release, ops).";
    case "reports": return "self-review and regression reports (provenance).";
    case "plans": return "committed implementation plans and design notes.";
    default: return `agent-authored ${topic}.`;
  }
}

/**
 * Render a scoped npm package name as the directory name `@ctxr/kit` uses
 * under ~/.claude/skills/. Example: "@ctxr/skill-llm-wiki" -> "ctxr-skill-llm-wiki".
 */
function kitSkillDirName(pkg) {
  return pkg.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * Probe order used to find an installed kit skill. Covers every kit-supported
 * destination for the `skill` artifact type. See @ctxr/kit's
 * src/lib/types.js `ARTIFACT_TYPES.skill` — project-local skills may live
 * under `.claude/skills/` (Claude-native) or `.agents/skills/` (open-standard
 * parallel); user-global skills always live at `~/.claude/skills/`.
 */
function kitSkillCandidatePaths(provider, target) {
  const dirName = kitSkillDirName(provider);
  return [
    join(homedir(), ".claude", "skills", dirName),
    join(target, ".claude", "skills", dirName),
    join(target, ".agents", "skills", dirName),
  ];
}

/**
 * Locate an installed kit skill. Returns the first candidate path that
 * contains a SKILL.md, or null when none does.
 */
function locateKitSkill(provider, target) {
  for (const candidate of kitSkillCandidatePaths(provider, target)) {
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

function printHelp() {
  process.stdout.write(
    [
      "install.mjs  wrapper-based installer",
      "",
      "Options:",
      "  --target <path>   project root (default: cwd)",
      "  --dry-run         default; print plan, do not write",
      "  --apply           perform a fresh install (bootstrap if needed)",
      "  --update          refresh above-marker section of every existing wrapper;",
      "                    preserve below-marker user overrides byte-for-byte",
      "  --uninstall       remove wrappers per manifest; preserve user-populated",
      "                    below-marker content",
      "  --yes             accept prompt defaults non-interactively",
      "",
    ].join("\n")
  );
}

function buildSkillAbove(name, canonicalRel, headerNotice) {
  const fm = [
    "---",
    `name: ${name}`,
    `description: Wrapper for agent-staff-engineer skill '${name}'. Canonical at ${canonicalRel}.`,
    `source: ${canonicalRel}`,
    `source_role: wrapper`,
    "---",
  ].join("\n");
  return [
    fm,
    "",
    `<!-- ${headerNotice} -->`,
    "",
    `Before acting, read and follow the canonical skill definition at:`,
    `\`${canonicalRel}\``,
    "",
    `That file is updated by \`git pull\` inside the agent bundle. This wrapper`,
    `continues to reference the same path so updates are picked up automatically.`,
    ``,
  ].join("\n");
}

function buildRuleAbove(name, canonicalRel, headerNotice) {
  const fm = [
    "---",
    `name: ${name}`,
    `description: Wrapper for agent-staff-engineer rule '${name}'. Canonical at ${canonicalRel}.`,
    `source: ${canonicalRel}`,
    `source_role: wrapper`,
    "---",
  ].join("\n");
  return [
    fm,
    "",
    `<!-- ${headerNotice} -->`,
    "",
    `Before acting on this rule, read and follow the canonical rule at:`,
    `\`${canonicalRel}\``,
    "",
    `Updates to the canonical rule take effect the next time you run Claude on`,
    `this project; no reinstall required. This wrapper's above-marker section is`,
    `regenerated only when you run \`install.mjs --update\`.`,
    ``,
  ].join("\n");
}

/**
 * Build the agent-managed section that lives between the begin/end markers
 * in the project's CLAUDE.md. The caller (`injectManagedBlock`) adds the
 * markers and any preamble. This function is pure; it produces the same
 * output for the same config, which keeps update diffs stable.
 */
function buildClaudeMdManagedBlock(cfg, agentPrefix) {
  // Defence-in-depth against weird/accidental config values bleeding into
  // markdown. Strip backticks, newlines, and "${" template splices; leave
  // bare `$` alone because it is a valid path character in some environments.
  const safePath = (s) =>
    String(s ?? "")
      .replace(/`/g, "")
      .replace(/\n/g, "")
      .replace(/\$\{/g, "");
  const bundle = safePath(cfg.paths.agent_bundle_dir);
  // Rule wrappers live at cfg.paths.wrappers.rules_dir (configurable, default
  // ".claude/rules"). Normalise to POSIX and strip any leading "./" so the
  // rendered paths stay clean and portable across platforms.
  const rulesDir = safePath(cfg.paths.wrappers.rules_dir)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  // Wrappers are written under `<prefix>_<shortname>` so they cannot collide
  // with rules from other agents. The references below MUST match the
  // filenames the installer writes.
  const rule = (short) => `\`${rulesDir}/${agentPrefix}_${short}.md\``;
  return [
    `This project is configured with the agent-staff-engineer bundle at \`${bundle}\`.`,
    "",
    `**Before acting on any task, read the bundle rules as wrappers at**:`,
    "",
    `- ${rule("tracker-source-of-truth")}`,
    `- ${rule("pr-workflow")}`,
    `- ${rule("no-dashes")}`,
    `- ${rule("plan-management")}`,
    `- ${rule("review-loop")}`,
    `- ${rule("memory-hygiene")}`,
    `- ${rule("adaptation")}`,
    "",
    `Each wrapper points at the canonical file inside the bundle. Update the`,
    `canonical rules by running \`git pull\` inside \`${bundle}\`.`,
    "",
    `**Configuration** (do not hand-edit; use bootstrap-ops-config or adapt-system):`,
    "",
    `- \`.claude/ops.config.json\` is the agent's contract.`,
    `- \`${bundle}/schemas/ops.config.schema.json\` is the schema.`,
    "",
    `**Project-specific rules** (outside the bundle, not updated by \`git pull\`):`,
    "",
    `- Any \`${rulesDir}/product-*.md\` files in this repo.`,
    "",
  ].join("\n");
}

// mergeWrapper lives in scripts/lib/wrapper.mjs so it can be unit-tested in
// isolation. The implementation has not moved inline intentionally.

// ensureGitignore lives in scripts/lib/gitignore.mjs so it is unit-testable.

async function runUninstall({ dryRun = false } = {}) {
  const { manifest, path: manifestPath, legacy: manifestIsLegacy } = await readManifestJson();
  if (!manifest || !Array.isArray(manifest.wrappers)) {
    process.stderr.write(
      `no manifest at ${MANIFEST_PATH} (or legacy ${LEGACY_MANIFEST_PATH}); nothing to uninstall.\n`
    );
    process.exit(1);
  }
  if (manifestIsLegacy) {
    process.stdout.write(
      `reading legacy manifest at ${relative(TARGET, manifestPath)}; it will be removed at the end of uninstall.\n`
    );
  }
  const marker = opsConfigOrDefault().paths.wrappers.marker;
  if (dryRun) {
    process.stdout.write(`\n(dry-run) uninstall would touch ${manifest.wrappers.length} wrapper(s):\n`);
    for (const entry of manifest.wrappers) {
      const abs = resolvePortable(entry.path, TARGET);
      process.stdout.write(`  would remove: ${relative(TARGET, abs)}\n`);
    }
    process.stdout.write(`\nRe-run without --dry-run to actually remove them.\n`);
    return;
  }
  for (const entry of manifest.wrappers) {
    const absPath = resolvePortable(entry.path, TARGET);
    const content = await readTextOrNull(absPath);
    if (content == null) {
      process.stdout.write(`skip (missing): ${relative(TARGET, absPath)}\n`);
      continue;
    }

    // The project-level CLAUDE.md is a managed-block injection, not a wrapper
    // file. Strip the block, preserve user content outside it. If nothing is
    // left (i.e. we created the file), delete it. Otherwise keep the file.
    if (entry.kind === "project-claude-md") {
      const stripped = removeManagedBlock(content, {
        begin: CLAUDE_MD_BEGIN_MARKER,
        end: CLAUDE_MD_END_MARKER,
      });
      if (stripped === content) {
        process.stdout.write(
          `skip: ${relative(TARGET, absPath)} (managed block already absent)\n`
        );
        continue;
      }
      const remaining = stripped.replace(/\s+/g, "");
      if (remaining.length === 0) {
        await rm(absPath, { force: true });
        process.stdout.write(`removed: ${relative(TARGET, absPath)} (no user content outside managed block)\n`);
      } else {
        await atomicWriteText(absPath, stripped);
        process.stdout.write(`stripped managed block from: ${relative(TARGET, absPath)} (user content preserved)\n`);
      }
      continue;
    }

    // Legacy `project-claude-md-alt` entries from an older install layout
    // pointed at a sidecar CLAUDE.agent.md file. Preserve user content by
    // renaming to .userkeep.md rather than deleting outright.
    if (entry.kind === "project-claude-md-alt") {
      const keepPath = absPath.replace(/\.md$/, ".userkeep.md");
      await atomicWriteText(keepPath, content);
      await rm(absPath, { force: true });
      process.stdout.write(
        `legacy CLAUDE.agent.md migrated: ${relative(TARGET, keepPath)} (please review and fold any edits into your CLAUDE.md)\n`
      );
      continue;
    }

    // Wrapper-style files (skills, rules, memory seeds) use the single-marker
    // split with below-marker as the user overrides zone.
    const markerIdx = content.indexOf(marker);
    const below = markerIdx >= 0 ? content.slice(markerIdx + marker.length) : "";
    const belowHasUserText = below.replace(/\s+/g, "").length > 0;
    if (belowHasUserText) {
      const keepPath = absPath.replace(/\.md$/, ".userkeep.md");
      await atomicWriteText(keepPath, content);
      await rm(absPath, { force: true });
      process.stdout.write(`preserved user overrides: ${relative(TARGET, keepPath)}\n`);
    } else {
      await rm(absPath, { force: true });
      process.stdout.write(`removed: ${relative(TARGET, absPath)}\n`);
    }
  }
  await rm(MANIFEST_PATH, { force: true });
  await rm(LEGACY_MANIFEST_PATH, { force: true });
  process.stdout.write(
    `\nuninstall complete. bundle folder still at ${BUNDLE_ABS}; remove it with 'rm -rf ${BUNDLE_ABS}' if desired.\n`
  );
}

function opsConfigOrDefault() {
  return (
    opsConfig ?? {
      paths: {
        wrappers: {
          marker:
            "<!-- ============ PROJECT OVERRIDES BELOW (preserved across agent updates) ============ -->",
        },
      },
    }
  );
}

// `safeRealpath` now lives in scripts/lib/fsx.mjs (`safeRealpathOrExit`) so
// every CLI script (install, bootstrap, update_self, install_memory_seeds)
// renders the same friendly error on ENOENT without duplicating code.
