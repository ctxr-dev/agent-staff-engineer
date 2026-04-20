#!/usr/bin/env node
// bootstrap.mjs
// Interactive interview backing the bootstrap-ops-config skill.
// Two phases:
//   1) Detection (silent reads): git, gh, codebase heuristics.
//   2) Interview (8 topics): user input wins over heuristics when they conflict.
// Produces:
//   <target>/.claude/ops.config.json
//   <target>/.claude/.bootstrap-answers.json
//
// Usage:
//   node bootstrap.mjs --target <path> [--dry-run] [--apply] [--yes]

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { preflight } from "./preflight.mjs";
import { parseArgv, boolFlag } from "./lib/argv.mjs";
import {
  atomicWriteJson,
  ensureDir,
  exists,
  readJsonOrNull,
  safeRealpathOrExit,
} from "./lib/fsx.mjs";
import { ghExec, ghAuthReady } from "./lib/ghExec.mjs";
import { validate } from "./lib/schema.mjs";
import { diffLines } from "./lib/diff.mjs";

// Guard: only run the interactive body when this file is the process entrypoint.
// When tests import the module to exercise the exported helpers, the main body
// must not run (no preflight exit, no argv parse, no interview).
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await main();
}

async function main() {
  await preflight();

  const { flags } = parseArgv(process.argv.slice(2), {
    booleans: new Set(["dry-run", "apply", "yes", "update", "help", "auto-install-node"]),
  });

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  // Self-locate: bundle is the parent directory of this script file, wherever
  // kit placed it. Resolve through realpath so that /tmp -> /private/tmp style
  // symlinks on macOS do not break the inside-TARGET check.
  const TARGET = await safeRealpathOrExit(resolve(flags.target ?? "."), "target");
  const BUNDLE_ABS = await safeRealpathOrExit(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "bundle");
  const BUNDLE_REF = (() => {
    const rel = relative(TARGET, BUNDLE_ABS);
    if (!rel.startsWith("..") && !rel.includes(":")) return rel || ".";
    return BUNDLE_ABS;
  })();
  const APPLY = boolFlag(flags, "apply", false);
  const DRY_RUN = !APPLY; // default posture
  const AUTO_YES = boolFlag(flags, "yes", false);

  const configPath = join(TARGET, ".claude/ops.config.json");
  // Answers transcript lives in the TARGET project, not the bundle. Bundles can
  // be user-global and read-only (see install.mjs for the same reasoning).
  const answersPath = join(TARGET, ".claude/.bootstrap-answers.json");
  const schemaPath = join(BUNDLE_ABS, "schemas/ops.config.schema.json");

  process.stdout.write(`\nbootstrap-ops-config\n`);
  process.stdout.write(`target: ${TARGET}\n`);
  process.stdout.write(`mode:   ${DRY_RUN ? "dry-run (no writes)" : "apply"}\n\n`);

  const detection = {
    git: detectGit(TARGET),
    gh: await detectGh(),
    tracker: detectTrackerHints(),
    stack: await detectStack(TARGET),
    devHints: await detectDevHints(TARGET),
  };

  printDetectionReport(detection);

  const rl = createInterface({ input, output });
  // Propagate SIGINT cleanly so CI pipelines and piped stdin do not hang.
  const onSigint = () => {
    rl.close();
    process.stderr.write("\nbootstrap: interrupted\n");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  rl.on("close", () => {});

  let answers;
  try {
    answers = AUTO_YES ? pickDefaults(detection) : await interview(rl, detection, BUNDLE_REF);
  } finally {
    rl.close();
    process.off("SIGINT", onSigint);
  }

  const opsConfig = compose(detection, answers, BUNDLE_REF);
  const schema = await readJsonOrNull(schemaPath);
  if (!schema) {
    fatal(
      `Schema not found at ${schemaPath}. The bundle self-locates from this script, so this means the bundle is incomplete at ${BUNDLE_ABS}.`
    );
  }
  const v = validate(schema, opsConfig);
  if (!v.ok) {
    process.stderr.write(`\nproposed ops.config.json FAILED schema validation:\n`);
    for (const e of v.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.stderr.write(`\nNot writing. Re-run with --help or adjust your answers.\n`);
    process.exit(1);
  }

  const existing = (await readJsonOrNull(configPath)) ?? {};
  const preview = diffLines(JSON.stringify(existing, null, 2), JSON.stringify(opsConfig, null, 2), {
    labelA: configPath + " (existing)",
    labelB: configPath + " (proposed)",
  });

  if (preview.trim()) {
    process.stdout.write(`\n--- proposed diff ---\n${preview}\n`);
  } else {
    process.stdout.write(`\nproposed config matches current config; no changes.\n`);
  }

  if (DRY_RUN) {
    process.stdout.write(`\n(dry-run) no files written. Re-run with --apply to commit.\n`);
    process.exit(0);
  }

  await atomicWriteJson(configPath, opsConfig);
  await ensureDir(dirname(answersPath));
  await atomicWriteJson(answersPath, {
    date: new Date().toISOString(),
    detection,
    answers,
  });
  process.stdout.write(`\nwrote ${configPath}\nwrote ${answersPath}\n`);
}

// ---- Functions (all exported for unit testing) --------------------------

function printHelp() {
  const text = `
bootstrap.mjs  interactive cold-start of ops.config.json

Options:
  --target <path>   target project root (default: cwd)
  --dry-run         default; print proposal, do not write
  --apply           write the proposal
  --yes             accept detected defaults without prompting (scripted install)
  --help            this message
`;
  process.stdout.write(text + "\n");
}

function fatal(msg) {
  process.stderr.write(`bootstrap: ${msg}\n`);
  process.exit(1);
}

export function detectGit(target) {
  // Swallow git stderr so running in a non-git directory does not spew
  // "fatal: not a git repository" before the detection report.
  const quietStdio = ["ignore", "pipe", "ignore"];
  const remote = spawnSync("git", ["-C", target, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: quietStdio,
  });
  const branch = spawnSync("git", ["-C", target, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: quietStdio,
  });
  const remoteUrl = remote.status === 0 ? remote.stdout.trim() : null;
  const headBranch = branch.status === 0 ? branch.stdout.trim() : null;
  return {
    remote: remoteUrl,
    defaultBranch: headBranch ?? "main",
    ownerRepo: parseOwnerRepo(remoteUrl),
  };
}

export function parseOwnerRepo(url) {
  if (!url) return null;
  // git@host:owner/repo.git  or  https://host/owner/repo(.git)
  const m =
    url.match(/[:/]([^:/]+)\/([^/]+?)(?:\.git)?$/) ??
    url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  // Only accept ASCII owner/repo identifiers; the schema enforces the same
  // shape, so rejecting here avoids writing an invalid config.
  const owner = m[1];
  const repo = m[2];
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(owner) || !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(repo)) {
    return null;
  }
  return `${owner}/${repo}`;
}

/**
 * Infer the likely tracker kind from a git remote URL. Returns null for
 * unrecognised hosts (the user picks during the interview). github.com
 * and gitlab.com have obvious mappings; self-hosted GitLab is detected
 * via the 'gitlab' substring. Bitbucket and others are not supported
 * today and return null so the interview surfaces the limitation.
 *
 * Handles all standard git remote URL forms:
 *   - git@host:owner/repo.git          (SCP-style)
 *   - https://host/owner/repo(.git)    (HTTPS)
 *   - ssh://git@host[:port]/owner/repo (SSH)
 *   - ssh://host/owner/repo            (SSH, no user)
 *   - git+ssh://... / git://...        (less common, still supported)
 */
export function parseHostKind(url) {
  if (!url) return null;
  const host = extractHost(url);
  if (!host) return null;
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower.endsWith(".github.com")) return "github";
  if (lower === "gitlab.com" || lower.includes("gitlab")) return "gitlab";
  return null;
}

/**
 * Extract the hostname from a git remote URL. Exported for reuse by
 * gitlab coordinate derivation (same parsing logic). Returns null if
 * the URL doesn't match a known form. Strips a trailing `:port`
 * segment so `ssh://git@host:2222/...` yields "host", not "host:2222".
 */
export function extractHost(url) {
  if (!url) return null;
  // SCP-style: git@host:path
  let m = url.match(/^[^@\s:/]+@([^:/\s]+):/);
  if (m) return m[1];
  // URL-style: (http|https|ssh|git|git+ssh)://[user@]host[:port]/...
  m = url.match(/^(?:https?|ssh|git(?:\+ssh)?):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?/);
  if (m) return m[1];
  return null;
}

/**
 * Probe the environment for tracker-specific auth tokens and config
 * files. Returns a per-kind presence map; interview uses it to default
 * the tracker-kind prompt and surface credential issues.
 *
 * Note on jira-cli config: the tool's historical config dir is
 * ~/.config/.jira/ (note the leading dot). Newer builds use
 * ~/.config/jira/. Check both so users on either version are covered.
 */
export function detectTrackerHints() {
  const env = process.env;
  const home = homedir();
  return {
    jira: {
      hasToken: typeof env.JIRA_API_TOKEN === "string" && env.JIRA_API_TOKEN.length > 0,
      cliConfig:
        fileExistsSync(join(home, ".config", ".jira", "config.yml")) ||
        fileExistsSync(join(home, ".config", "jira", "config.yml")),
    },
    linear: {
      hasToken: typeof env.LINEAR_API_KEY === "string" && env.LINEAR_API_KEY.length > 0,
    },
    gitlab: {
      hasToken: typeof env.GITLAB_TOKEN === "string" && env.GITLAB_TOKEN.length > 0,
      glab: isOnPath("glab"),
    },
  };
}

function fileExistsSync(path) {
  // Node-native. Previously shelled out to POSIX `test -f`, which
  // breaks on Windows and on any environment without a PATH-resolved
  // `test`. fs.statSync is available everywhere Node runs; the
  // isFile() guard distinguishes a file from a directory with the
  // same name (e.g. a user who created ~/.config/jira/ as a dir but
  // no config.yml).
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Node-native `which`: returns true if `cmd` resolves to an executable
 * file anywhere on the user's PATH. Previously shelled out to the
 * POSIX `command -v` builtin, which is not available on Windows
 * shells and would always report "not found" there.
 *
 * Iterates PATH once, testing each candidate. On POSIX the candidate
 * must be a regular file AND have the execute bit set for the current
 * user, which rules out false positives like a text file sitting on
 * PATH with a name that happens to collide with a tool. On Windows
 * PATHEXT already provides the executability signal via the extension,
 * so the isFile() check plus PATHEXT suffices; `accessSync(.., X_OK)`
 * behaves inconsistently on Windows (cmd / ACL files can surface
 * EACCES even when they're runnable).
 *
 * Exported so tests can exercise it without spawning a child process.
 */
export function isOnPath(cmd) {
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return false;
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = `${dir}${sep}${cmd}${ext}`;
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!isWin) {
          // accessSync throws on EACCES when the execute bit is not
          // set for the current uid/gid, ruling out non-executable
          // files with a tool-like name.
          accessSync(candidate, fsConstants.X_OK);
        }
        return true;
      } catch {
        // ENOENT / EACCES / not-a-file: skip and keep scanning.
      }
    }
  }
  return false;
}

export async function detectGh() {
  const authed = await ghAuthReady();
  if (!authed) return { authed: false };
  const userRes = await ghExec(["api", "user"], { format: "json", timeoutMs: 8000 });
  return {
    authed: true,
    login: userRes.json?.login ?? null,
  };
}

export async function detectStack(target) {
  const language = [];
  const testing = [];
  const platform = [];

  const hint = async (filename) => (await exists(join(target, filename)));

  if (await hint("Package.swift")) language.push("swift");
  if (await hasAnySwiftFile(target)) language.push("swift");
  if (await hint("package.json")) language.push("typescript"); // we'll ask to refine
  if (await hint("pyproject.toml")) language.push("python");
  if (await hint("go.mod")) language.push("go");
  if (await hint("Cargo.toml")) language.push("rust");
  if (await hint("Gemfile")) language.push("ruby");

  // Test framework heuristics.
  if (await hint("playwright.config.ts")) testing.push("playwright");
  if (await hint("playwright.config.js")) testing.push("playwright");
  if (await hint("vitest.config.ts")) testing.push("vitest");
  if (await hint("vitest.config.js")) testing.push("vitest");
  if (await hint("jest.config.ts")) testing.push("jest");
  if (await hint("jest.config.js")) testing.push("jest");
  if (await hint("pytest.ini")) testing.push("pytest");
  if (await hint("tsconfig.json") && language.includes("typescript")) {
    // nothing more to infer generically.
  }

  if (await hint("Info.plist") || language.includes("swift")) platform.push("ios");
  if (await hint("next.config.js") || await hint("next.config.ts")) platform.push("web");

  return { language: dedupe(language), testing: dedupe(testing), platform: dedupe(platform) };
}

async function hasAnySwiftFile(target) {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.some((e) => e.isFile() && e.name.endsWith(".swift"));
  } catch {
    return false;
  }
}

export async function detectDevHints(target) {
  return {
    hasRolloutMd: await exists(join(target, ".claude/plans/rollout.md")),
    hasPlansDir: await exists(join(target, ".claude/plans")),
    hasDevelopmentDir: await exists(join(target, ".development")),
    hasIssueTemplates: await exists(join(target, ".github/ISSUE_TEMPLATE")),
    hasGhWorkflows: await exists(join(target, ".github/workflows")),
  };
}

function printDetectionReport(d) {
  process.stdout.write("detection\n");
  process.stdout.write(`  git remote:     ${d.git.remote ?? "(not a git remote)"}\n`);
  process.stdout.write(`  default branch: ${d.git.defaultBranch}\n`);
  process.stdout.write(`  owner/repo:     ${d.git.ownerRepo ?? "(unknown)"}\n`);
  // Show both the actual host (useful when the user needs to tell
  // the difference between gitlab.com and a self-hosted gitlab) AND
  // the tracker kind the host maps to. Previously the "remote host"
  // line printed the kind, which was misleading.
  process.stdout.write(`  remote host:    ${extractHost(d.git.remote) ?? "(unknown)"}\n`);
  process.stdout.write(`  remote kind:    ${parseHostKind(d.git.remote) ?? "(unknown / unsupported)"}\n`);
  process.stdout.write(`  gh authed:      ${d.gh.authed ? `yes (${d.gh.login ?? "?"})` : "no"}\n`);
  const t = d.tracker ?? {};
  process.stdout.write(`  jira hints:     token=${t.jira?.hasToken ? "yes" : "no"}, cli-config=${t.jira?.cliConfig ? "yes" : "no"}\n`);
  process.stdout.write(`  linear hints:   token=${t.linear?.hasToken ? "yes" : "no"}\n`);
  process.stdout.write(`  gitlab hints:   token=${t.gitlab?.hasToken ? "yes" : "no"}, glab=${t.gitlab?.glab ? "yes" : "no"}\n`);
  process.stdout.write(`  language hints: ${d.stack.language.join(", ") || "(none)"}\n`);
  process.stdout.write(`  testing hints:  ${d.stack.testing.join(", ") || "(none)"}\n`);
  process.stdout.write(`  platform hints: ${d.stack.platform.join(", ") || "(none)"}\n`);
  process.stdout.write(`  rollout.md:     ${d.devHints.hasRolloutMd ? "present" : "absent"}\n`);
  process.stdout.write(`  .development:   ${d.devHints.hasDevelopmentDir ? "present" : "absent"}\n`);
  process.stdout.write("\n");
}

/**
 * Pick the best-default tracker kind from detection signals. Priority:
 *   1. Git remote host (github.com -> github; gitlab.com / self-hosted
 *      gitlab -> gitlab). A repo whose code lives on GitHub almost
 *      always tracks issues on the same host; the user can override.
 *   2. Credential hints (JIRA token, LINEAR key, GITLAB token) — only
 *      when the remote was inconclusive. If multiple tokens are set
 *      we refuse to guess and return null so the user picks.
 *   3. null -> interview asks explicitly, defaulting to "github".
 */
export function inferTrackerKind(detection) {
  const remoteKind = parseHostKind(detection?.git?.remote);
  if (remoteKind) return remoteKind;
  const t = detection?.tracker ?? {};
  const credentialed = [];
  if (t.jira?.hasToken || t.jira?.cliConfig) credentialed.push("jira");
  if (t.linear?.hasToken) credentialed.push("linear");
  if (t.gitlab?.hasToken || t.gitlab?.glab) credentialed.push("gitlab");
  if (credentialed.length === 1) return credentialed[0];
  return null;
}

async function interview(rl, d, _bundleRef) {
  const ask = async (q, def = "") => {
    const s = await rl.question(`${q}${def ? ` [${def}]` : ""}: `);
    return s.trim() || def;
  };
  const askYesNo = async (q, def = "yes") => {
    const s = (await ask(q, def)).toLowerCase();
    return s === "" ? def === "yes" : s.startsWith("y");
  };
  const askCsv = async (q, def = "") => {
    const s = await ask(q, def);
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  };

  process.stdout.write("interview (9 topics). Enter accepts the default shown in brackets.\n");
  process.stdout.write("Note: on GitHub, only the review namespace is implemented today (used by skills/pr-iteration); issues / projects / labels namespaces are stubbed. Jira / Linear / GitLab backends accept the config but EVERY op (read or write) throws NotSupportedError until their real impls land.\n\n");

  const cadence = await ask(
    "1. Release cadence: continuous / per-wave / per-version / adhoc",
    "per-wave"
  );
  const teamSize = await ask("2. Team size: solo / small (2-5) / larger", "solo");
  const pushAllowedRaw = await ask(
    "   Who may push to the default branch? Comma-separated logins",
    d.gh.login ?? ""
  );
  const reviewersRaw = await ask(
    "   Default reviewers (comma-separated; include 'copilot' if available)",
    [d.gh.login, "copilot"].filter(Boolean).join(",")
  );
  const e2eSetup = await ask(
    "3. e2e setup: none / xcuitest / playwright / cypress / pytest / other",
    d.stack.testing[0] ?? "none"
  );
  const e2ePath = await ask("   e2e scripts path (empty if N/A)", "");

  const inferredKind = inferTrackerKind(d) ?? "github";
  const devKind = await askTrackerKind(
    ask,
    "4. Tracker hosting dev issues: github / jira / linear / gitlab",
    inferredKind,
  );
  const devTracker = await askTrackerTarget(ask, devKind, "dev", d);

  // Release umbrellas are optional. Teams that don't use one coordinating
  // issue per release (solo, continuous deploy, milestone-based workflows)
  // skip this block entirely. The schema treats `trackers.release` as
  // optional; consumer skills (release-tracker, dev-loop's link-umbrella
  // step) short-circuit when it's absent.
  const usesReleaseUmbrellas = await askYesNo(
    "5. Do you use release-umbrella issues (one coordinating issue per release)? If unsure, say no; you can add this later via adapt-system",
    "no"
  );
  let releaseTracker;
  if (usesReleaseUmbrellas) {
    const releaseKind = await askTrackerKind(
      ask,
      "   Tracker hosting release umbrellas: github / jira / linear / gitlab (default: same as dev)",
      devKind,
    );
    releaseTracker = await askTrackerTarget(ask, releaseKind, "release", d, devTracker);
  }

  // Branch naming. Defaults work for most projects and match conventional
  // commit prefixes. A user who wants something different can customise
  // per-type here, or later via adapt-system.
  const DEFAULT_BRANCH_PATTERNS = {
    feature: "feat/{issue}-{slug}",
    fix: "fix/{issue}-{slug}",
    chore: "chore/{issue}-{slug}",
    refactor: "refactor/{issue}-{slug}",
    docs: "docs/{issue}-{slug}",
  };
  const customiseBranchNaming = await askYesNo(
    `6. Customise branch naming? Defaults: feat/{issue}-{slug}, fix/{issue}-{slug}, chore/{issue}-{slug}, refactor/{issue}-{slug}, docs/{issue}-{slug}. Placeholders {issue} and {slug} are required`,
    "no"
  );
  let branchPatterns = DEFAULT_BRANCH_PATTERNS;
  if (customiseBranchNaming) {
    branchPatterns = {};
    for (const type of ["feature", "fix", "chore", "refactor", "docs"]) {
      branchPatterns[type] = await askBranchPattern(
        ask,
        `   ${type} branches`,
        DEFAULT_BRANCH_PATTERNS[type],
      );
    }
  }

  const observedReposStr = await ask(
    "7. Additional observed GitHub repos (owner/name), comma-separated, blank for none",
    ""
  );
  const defaultDepth = await ask(
    "   Default observation depth: full / umbrella-only / assigned-to-principals / labeled:X / issues-only / read-only",
    "full"
  );
  const observed = parseObservedGithubRepos(observedReposStr, defaultDepth);

  const regimes = await askCsv(
    "8. Compliance regimes: gdpr,ccpa,soc2,pci,hipaa,mhmda,appi,pipa,lgpd or 'none'",
    "none"
  );
  const dataClasses = await askCsv(
    "   Data classes handled: pii,payment,health,phi,financial,biometric,location,child-data or 'none'",
    "none"
  );
  const seedProductRules = await askYesNo(
    "9. Seed any project-specific rules now? (you can add later via adapt-system)",
    "no"
  );

  return {
    cadence,
    teamSize,
    pushAllowed: pushAllowedRaw.split(",").map((s) => s.trim()).filter(Boolean),
    reviewers: reviewersRaw.split(",").map((s) => s.trim()).filter(Boolean),
    e2eSetup,
    e2ePath,
    devTracker,
    releaseTracker,
    branchPatterns,
    observed,
    // defaultDepth lives as a local variable only: its single use is
    // parseObservedGithubRepos() above, which consumes it inline to
    // stamp each observed tracker. compose() doesn't re-read it, so
    // persisting it in the answers object would imply a downstream
    // effect it doesn't actually have.
    regimes,
    dataClasses,
    seedProductRules,
  };
}

/** The tracker kinds askTrackerTarget() knows how to ask questions for. */
export const SUPPORTED_TRACKER_KINDS = Object.freeze(["github", "jira", "linear", "gitlab"]);

/**
 * Ask a prompt, normalise the answer (trim), optionally validate it
 * against a regex, re-prompt on empty or pattern-mismatched input up
 * to 3 times with a pointed stderr warning, and throw after the final
 * attempt. Used for every required tracker-coordinate prompt (owner,
 * repo, jira site, linear team key, gitlab project_path, etc.) so
 * invalid input surfaces an actionable error at prompt time rather
 * than blowing up later in schema validation with a generic "required
 * property" / "does not match pattern" message.
 *
 * `humanLabel` appears in the warning and error text (short form, e.g.
 * "GitHub owner", "Linear team key"). The `options.pattern` regex, if
 * supplied, is tested against the trimmed value; `options.patternHelp`
 * is a one-liner shown to the user on mismatch explaining the expected
 * format (e.g. "2-10 uppercase letters, e.g. ENG").
 */
export async function askNonEmpty(ask, question, defaultValue, humanLabel, options = {}) {
  const MAX_ATTEMPTS = 3;
  const { pattern = null, patternHelp = "" } = options;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await ask(question, defaultValue);
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      process.stderr.write(
        `bootstrap: ${humanLabel} is required (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
        "Enter a non-empty value.\n",
      );
      continue;
    }
    if (pattern && !pattern.test(trimmed)) {
      process.stderr.write(
        `bootstrap: ${humanLabel} '${trimmed}' does not match the expected format (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
        `${patternHelp || "See the schema for the accepted shape."}\n`,
      );
      continue;
    }
    return trimmed;
  }
  throw new Error(
    `bootstrap: could not obtain a valid ${humanLabel} after ${MAX_ATTEMPTS} attempts; re-run and enter a non-empty value${pattern ? ` matching the expected format` : ""}`,
  );
}

/**
 * Ask a tracker-kind question, normalise the answer (trim + lowercase),
 * validate against SUPPORTED_TRACKER_KINDS, and re-prompt up to 3 times
 * on invalid input before giving up and throwing. Bounding the retries
 * matters for CI-style runs where stdin is closed early: without the
 * bound, askRetry would spin forever on EOF.
 *
 * Typed out as its own helper (rather than inlined in interview()) so
 * future tracker prompts (e.g. workspace-member trackers) get the same
 * normalisation + validation without copy-paste.
 */
export async function askTrackerKind(ask, question, defaultValue) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const rawAnswer = await ask(question, defaultValue);
    const normalised = String(rawAnswer ?? "").trim().toLowerCase();
    if (SUPPORTED_TRACKER_KINDS.includes(normalised)) {
      return normalised;
    }
    process.stderr.write(
      `bootstrap: '${rawAnswer}' is not a supported tracker kind (got attempt ${attempt}/${MAX_ATTEMPTS}). ` +
      `Expected one of: ${SUPPORTED_TRACKER_KINDS.join(", ")}.\n`,
    );
  }
  throw new Error(
    `bootstrap: could not obtain a valid tracker kind after ${MAX_ATTEMPTS} attempts; re-run and enter one of ${SUPPORTED_TRACKER_KINDS.join(", ")}`,
  );
}

/**
 * Ask for a branch-pattern template, validate that both `{issue}` and
 * `{slug}` placeholders are present (the schema's pattern check enforces
 * this downstream; catching it at prompt time gives a better error).
 * Up to 3 attempts, then fall back to the default. The schema's
 * workflow.branch_patterns.<type> pattern is
 * `^(?=.*\\{issue\\})(?=.*\\{slug\\}).*$` so the two tokens can appear
 * in EITHER order (`{issue}-{slug}` and `{slug}-{issue}` are both
 * valid) with prefix / suffix text. This prompt check (using
 * `includes` for each token separately) intentionally matches the
 * schema's order-independent contract, so any pattern accepted here
 * validates against the schema at compose time.
 */
export async function askBranchPattern(ask, label, defaultValue) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await ask(label, defaultValue);
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      // Empty → accept the default silently; users who Enter through
      // mean "keep the default".
      return defaultValue;
    }
    if (trimmed.includes("{issue}") && trimmed.includes("{slug}")) {
      return trimmed;
    }
    process.stderr.write(
      `bootstrap: branch pattern '${trimmed}' is missing one of {issue} / {slug} (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
      `Example: 'feat/{issue}-{slug}'.\n`,
    );
  }
  process.stderr.write(
    `bootstrap: could not obtain a valid ${label} after ${MAX_ATTEMPTS} attempts; keeping the default '${defaultValue}'.\n`,
  );
  return defaultValue;
}

/**
 * Ask the kind-specific questions needed to populate a `trackers.<role>`
 * entry, return a fully-formed tracker target object. `reference` is an
 * optional sibling target (e.g. devTracker when asking for
 * releaseTracker) used to default values the user can reuse across
 * roles.
 */
export async function askTrackerTarget(ask, kind, role, d, reference = null) {
  switch (kind) {
    case "github": {
      const [inferredOwner, inferredRepo] = (d.git.ownerRepo ?? "/").split("/");
      // Owner is required across both roles. Validate with the same
      // 3-attempt loop used for dev repo so a whitespace-only or empty
      // answer produces a pointed error at prompt time rather than a
      // schema-validation failure several steps later.
      const owner = await askNonEmpty(
        ask,
        "   GitHub owner",
        reference?.kind === "github" ? reference.owner : inferredOwner,
        "GitHub owner",
      );
      // Dev trackers require a concrete repo (schema enforces this via
      // the trackers.dev if/then conditional). Release trackers
      // legitimately span repos, so empty is accepted there, but we
      // still trim whitespace-only answers so `"   "` does not land as
      // a real repo name in the config.
      let repo;
      if (role === "dev") {
        repo = await askNonEmpty(
          ask,
          "   GitHub repo",
          reference?.kind === "github" ? reference.repo ?? "" : inferredRepo,
          "GitHub repo for the dev tracker",
        );
      } else {
        const raw = await ask("   GitHub repo (optional for release tracker that spans repos)", "");
        repo = String(raw ?? "").trim();
      }
      const projectNumRaw = await ask(
        `   ${role === "dev" ? "Dev" : "Release"} Project v2 number (blank to skip)`,
        role === "dev" ? "1" : "2",
      );
      const projectDepth = role === "dev" ? "full" : "umbrella-only";
      const projects = projectNumRaw && /^\d+$/.test(projectNumRaw.trim())
        ? [{
            owner,
            number: Number(projectNumRaw.trim()),
            depth: projectDepth,
            status_field: "Status",
            status_values: role === "dev"
              ? { backlog: "Backlog", ready: "Ready", in_progress: "In progress", in_review: "In review", done: "Done" }
              : { backlog: "Backlog", in_progress: "In progress", done: "Done" },
            fields: role === "dev"
              ? ["Area", "Intent", "Priority", "Size", "Estimate", "Iteration", "Linked Release"]
              : ["Target Date", "Scope Tag", "Linked Dev Issues"],
            label_scope: null,
          }]
        : [];
      const target = {
        kind: "github",
        owner,
        auth_login: d.gh.login || "",
        // Tracker-level depth mirrors the project's default-restrictive
        // semantics: dev trackers operate across every item in the repo
        // (full), but release trackers only ever touch umbrella issues
        // (umbrella-only). This matches the projectDepth chosen for the
        // bound Project v2 above, so a user who accepts defaults ends
        // up with consistent least-privilege settings across both the
        // tracker and its Project v2.
        depth: projectDepth,
        projects,
      };
      // `repo` is already trimmed above; only persist when non-empty.
      // Release trackers that legitimately span repos emit no `repo`
      // key at all, so the schema's github release path accepts them.
      if (repo) target.repo = repo;
      return target;
    }
    case "jira": {
      // Validate both fields at prompt time so the user sees a pointed
      // error naming the offending prompt, not a generic schema error
      // several interview steps later. Patterns mirror the schema's:
      //   site: "<subdomain>.atlassian.net" with dot-separated ASCII
      //   project: uppercase letters/digits/underscore, leading letter
      const site = await askNonEmpty(
        ask,
        "   Jira site (e.g. acme.atlassian.net)",
        reference?.kind === "jira" ? reference.site : "",
        "Jira site",
        {
          pattern: /^[A-Za-z0-9][A-Za-z0-9.-]*\.atlassian\.net$/,
          patternHelp: "Expected format: <subdomain>.atlassian.net (e.g. acme.atlassian.net).",
        },
      );
      const project = await askNonEmpty(
        ask,
        "   Jira project key (e.g. PLAT)",
        reference?.kind === "jira" ? reference.project : "",
        "Jira project key",
        {
          pattern: /^[A-Z][A-Z0-9_]*$/,
          patternHelp: "Expected format: uppercase letters / digits / underscore, starting with a letter (e.g. PLAT, ENG_2).",
        },
      );
      return {
        kind: "jira",
        site,
        project,
        // Role-derived default depth mirrors the github branch: dev
        // operates across the project, release narrows to umbrellas.
        depth: role === "dev" ? "full" : "umbrella-only",
        status_values: {
          backlog: "Backlog",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        labels_field: "labels",
      };
    }
    case "linear": {
      const workspace = await askNonEmpty(
        ask,
        "   Linear workspace URL key",
        reference?.kind === "linear" ? reference.workspace : "",
        "Linear workspace",
      );
      const team = await askNonEmpty(
        ask,
        "   Linear team key (2-10 uppercase letters / digits, starting with a letter, e.g. ENG)",
        reference?.kind === "linear" ? reference.team : "",
        "Linear team key",
        {
          pattern: /^[A-Z][A-Z0-9]{1,9}$/,
          patternHelp: "Expected format: 2-10 characters, uppercase letters or digits, starting with a letter (e.g. ENG, PROD2).",
        },
      );
      return {
        kind: "linear",
        workspace,
        team,
        depth: role === "dev" ? "full" : "umbrella-only",
        status_values: {
          backlog: "Backlog",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
      };
    }
    case "gitlab": {
      const host = await askNonEmpty(
        ask,
        "   GitLab host",
        reference?.kind === "gitlab" ? reference.host : "gitlab.com",
        "GitLab host",
      );
      const project_path = await askNonEmpty(
        ask,
        "   GitLab project_path (group/subgroup/repo, at least two segments)",
        reference?.kind === "gitlab" ? reference.project_path : "",
        "GitLab project_path",
        {
          // Matches the schema's pattern: at least two "/"-separated
          // segments of [A-Za-z0-9._-]+, e.g. group/repo or
          // group/subgroup/repo.
          pattern: /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/,
          patternHelp: "Expected format: at least two segments separated by '/' (e.g. acme/widgets or acme/platform/widgets).",
        },
      );
      return {
        kind: "gitlab",
        host,
        project_path,
        depth: role === "dev" ? "full" : "umbrella-only",
        status_values: {
          backlog: "backlog",
          in_progress: "in-progress",
          done: "done",
        },
      };
    }
    /* istanbul ignore next */
    default:
      throw new Error(`askTrackerTarget: unsupported kind '${kind}'`);
  }
}

/**
 * Parse a comma-separated list of `owner/name` strings into an array of
 * `githubTracker` observed-target objects with depth applied uniformly.
 * Each observed entry is a self-contained read-only tracker pointing at
 * one GitHub repo with no Projects v2 boards attached; cross-repo
 * lookups on Jira / Linear / GitLab targets use a different shape and
 * aren't covered by this helper yet.
 *
 * Malformed entries (missing `/`, empty segments, three-segment
 * `a/b/c` inputs, or non-ASCII identifiers that the schema rejects
 * downstream) are skipped with a single-line stderr warning naming
 * the offending pair. Failing loudly at parse time beats a generic
 * "schema validation error: trackers.observed[3].repo" later.
 */
export function parseObservedGithubRepos(s, depth) {
  if (!s) return [];
  const ident = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
  const out = [];
  for (const pair of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const parts = pair.split("/");
    if (parts.length !== 2) {
      process.stderr.write(
        `bootstrap: observed repo '${pair}' skipped (expected owner/name, got ${parts.length} segment${parts.length === 1 ? "" : "s"})\n`,
      );
      continue;
    }
    const [owner, name] = parts;
    if (!ident.test(owner) || !ident.test(name)) {
      process.stderr.write(
        `bootstrap: observed repo '${pair}' skipped (owner/name must match /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/)\n`,
      );
      continue;
    }
    out.push({
      kind: "github",
      owner,
      repo: name,
      depth,
      projects: [],
    });
  }
  return out;
}

export function pickDefaults(d) {
  // Scripted installs (--yes) skip the interview and write this shape
  // directly, then schema-validate. Any kind whose required fields
  // can't be filled from detection will fail that validation with an
  // unactionable "required property 'site'" / "owner is
  // unknown/unknown" error. To make --yes work out of the box we
  // restrict the default to kinds we can fully auto-populate:
  //   - github: needs d.git.ownerRepo.
  //   - gitlab: needs a gitlab git remote (host + project_path both
  //     derive from it).
  //   - jira / linear: no way to auto-derive site/project/workspace/team
  //     from the filesystem alone. Fall back to github IF we have a
  //     git remote; otherwise throw and tell the user to re-run
  //     without --yes so they can answer interactively.
  // Previously this function silently fell back to kind=github even
  // when ownerRepo was null; defaultTrackerTarget then produced
  // {owner: "unknown", repo: "unknown"} which is schema-valid but
  // unusable. Hard-fail is safer: the user sees one pointed error
  // instead of shipping a broken config they have to diagnose later.
  const inferred = inferTrackerKind(d);
  let kind;
  if (inferred && canAutoPopulate(inferred, d)) {
    kind = inferred;
  } else if (canAutoPopulate("github", d)) {
    kind = "github";
  } else {
    throw new Error(
      "bootstrap --yes: no tracker kind can be auto-populated from this environment " +
      "(no git remote with owner/repo was detected, and no credentialed fallback is " +
      "auto-populatable). Re-run without --yes so the interview can prompt for tracker " +
      "coordinates interactively.",
    );
  }
  const pushAllowed = [d.gh.login, "claude"].filter(Boolean);
  const reviewers = [d.gh.login, "copilot"].filter(Boolean);
  const devTracker = defaultTrackerTarget(kind, "dev", d);
  // --yes installs keep the legacy "always emit a release tracker" shape
  // so existing non-interactive pipelines don't break. Interactive
  // users decide via the bootstrap interview question. Teams that want
  // --yes to skip umbrellas can follow up with adapt-system or delete
  // `trackers.release` by hand.
  const releaseTracker = defaultTrackerTarget(kind, "release", d);
  return {
    cadence: "per-wave",
    teamSize: "solo",
    pushAllowed,
    reviewers,
    e2eSetup: d.stack.testing[0] ?? "none",
    e2ePath: "",
    devTracker,
    releaseTracker,
    // Match the schema default so downstream compose() emits the same
    // patterns it did before the interactive branch-naming question
    // existed.
    branchPatterns: {
      feature: "feat/{issue}-{slug}",
      fix: "fix/{issue}-{slug}",
      chore: "chore/{issue}-{slug}",
      refactor: "refactor/{issue}-{slug}",
      docs: "docs/{issue}-{slug}",
    },
    observed: [],
    regimes: ["none"],
    dataClasses: ["none"],
    seedProductRules: false,
  };
}

/**
 * Can we produce a schema-valid tracker target for `kind` using only
 * `detection`? Used by pickDefaults to keep --yes installs working
 * even when inferTrackerKind picks a kind whose required coordinates
 * aren't in the filesystem. Exported for tests.
 */
export function canAutoPopulate(kind, d) {
  switch (kind) {
    case "github":
      return Boolean(d?.git?.ownerRepo);
    case "gitlab":
      // Both host (from remote) and project_path (from remote path
      // segment) must be derivable. parseHostKind already confirms
      // the host looks like a gitlab. ownerRepo being present means
      // the remote parsed cleanly too.
      return Boolean(d?.git?.ownerRepo) && parseHostKind(d?.git?.remote) === "gitlab";
    case "jira":
    case "linear":
      // No filesystem-derivable source for site/project/workspace/team.
      // Interactive bootstrap or manual ops.config.json edit is required.
      return false;
    default:
      return false;
  }
}

/**
 * Extract the path portion of a git remote URL for use as a GitLab
 * project_path. Strips a trailing `.git` and any leading `/`. Returns
 * null for URLs that don't match a known form. Kept internal to this
 * module (tests exercise it through defaultTrackerTarget).
 */
function extractRemotePath(url) {
  if (!url) return null;
  // SCP-style: git@host:path(.git)
  let m = url.match(/^[^@\s:/]+@[^:/\s]+:([^\s]+?)(?:\.git)?$/);
  if (m) return m[1].replace(/^\/+/, "");
  // URL-style: scheme://[user@]host[:port]/path(.git)
  m = url.match(/^(?:https?|ssh|git(?:\+ssh)?):\/\/(?:[^@/\s]+@)?[^:/\s]+(?::\d+)?\/([^\s]+?)(?:\.git)?$/);
  if (m) return m[1].replace(/^\/+/, "");
  return null;
}

/**
 * Synthesise a minimal tracker target for --yes / scripted installs.
 * Uses detection output for the github case (owner/repo from git
 * remote); other kinds fall back to empty strings which the user must
 * fix later (or the schema validator will reject).
 */
export function defaultTrackerTarget(kind, role, d) {
  if (kind === "github") {
    const [owner, repo] = (d.git.ownerRepo ?? "unknown/unknown").split("/");
    const projectDepth = role === "dev" ? "full" : "umbrella-only";
    const target = {
      kind: "github",
      owner,
      auth_login: d.gh.login || "",
      // Tracker depth mirrors the bound Project v2's depth. dev =>
      // full (operate across the repo), release => umbrella-only
      // (touch only umbrella issues). Matches askTrackerTarget so
      // --yes installs and interactive installs produce identical
      // least-privilege shapes.
      depth: projectDepth,
      projects: [{
        owner,
        number: role === "dev" ? 1 : 2,
        depth: projectDepth,
        status_field: "Status",
        status_values: role === "dev"
          ? { backlog: "Backlog", ready: "Ready", in_progress: "In progress", in_review: "In review", done: "Done" }
          : { backlog: "Backlog", in_progress: "In progress", done: "Done" },
        fields: role === "dev"
          ? ["Area", "Intent", "Priority", "Size", "Estimate", "Iteration", "Linked Release"]
          : ["Target Date", "Scope Tag", "Linked Dev Issues"],
        label_scope: null,
      }],
    };
    if (role === "dev") target.repo = repo;
    return target;
  }
  // Role-derived default depth: dev covers the full project /
  // workspace; release narrows to umbrella issues. Matches the
  // github branch above and askTrackerTarget. Applied uniformly
  // across jira / linear / gitlab so --yes installs land on the
  // same least-privilege shape the interactive interview produces.
  const depth = role === "dev" ? "full" : "umbrella-only";
  if (kind === "jira") {
    return {
      kind: "jira",
      site: "",
      project: "",
      depth,
      status_values: { backlog: "Backlog", in_progress: "In Progress", in_review: "In Review", done: "Done" },
      labels_field: "labels",
    };
  }
  if (kind === "linear") {
    return {
      kind: "linear",
      workspace: "",
      team: "",
      depth,
      status_values: { backlog: "Backlog", in_progress: "In Progress", in_review: "In Review", done: "Done" },
    };
  }
  if (kind === "gitlab") {
    // Derive host + project_path from the git remote ONLY when the
    // remote actually looks like a GitLab URL. If the user asks for a
    // gitlab tracker on a repo whose code lives on GitHub (valid
    // scenario: code on one host, tickets on another), inheriting the
    // github.com host would be wrong. Fall back to the canonical
    // public host + empty project_path so the user's interactive
    // bootstrap or manual edit fills the gap. Empty project_path
    // still fails the schema's pattern on --yes, surfacing a pointed
    // "required property" error rather than a silent mis-config.
    const remoteIsGitlab = parseHostKind(d?.git?.remote) === "gitlab";
    const host = remoteIsGitlab ? extractHost(d.git.remote) : "gitlab.com";
    const project_path = remoteIsGitlab ? (extractRemotePath(d.git.remote) ?? "") : "";
    return {
      kind: "gitlab",
      host,
      project_path,
      depth,
      status_values: { backlog: "backlog", in_progress: "in-progress", done: "done" },
    };
  }
  throw new Error(`defaultTrackerTarget: unsupported kind '${kind}'`);
}

export function compose(d, a, bundleRef = ".claude/agents/agent-staff-engineer") {
  const [owner, repo] = (d.git.ownerRepo ?? "unknown/unknown").split("/");
  return {
    $schemaVersion: "0.1.0",
    project: {
      name: repo,
      org: owner,
      repo: d.git.ownerRepo ?? "unknown/unknown",
      default_branch: d.git.defaultBranch,
      principals: {
        push_allowed: a.pushAllowed.length ? a.pushAllowed : ["claude"],
        reviewers_default: a.reviewers,
      },
    },
    // trackers.release is omitted entirely when the user said "no" to
    // the release-umbrella question (a.releaseTracker is undefined).
    // The schema treats `release` as optional; consumers short-circuit
    // on absence. Conditionally spread so the key is literally missing
    // rather than set to undefined (which would fail strict schema).
    trackers: {
      dev: a.devTracker,
      ...(a.releaseTracker ? { release: a.releaseTracker } : {}),
      observed: a.observed ?? [],
    },
    labels: {
      type: ["feature", "bug", "task", "refactor", "docs", "chore"],
      area: [
        "frontend",
        "backend",
        "data",
        "security",
        "performance",
        "compliance",
        "ux",
        "devx",
        "testing",
        "docs",
      ],
      priority: ["p0-blocker", "p1-high", "p2-medium", "p3-low"],
      intent: cadenceToIntent(a.cadence),
      size: ["xs", "s", "m", "l", "xl"],
      automation: ["auto-regression", "auto-release-tracked"],
      state_modifiers: ["blocked", "deferred", "cancelled"],
    },
    workflow: {
      phase_term: a.cadence === "per-wave" ? "wave" : a.cadence === "per-version" ? "version" : "track",
      // Prefer the answers' branchPatterns (from the customise-yes path
      // in the interview or from pickDefaults' default block); fall
      // back to the conventional defaults if an older caller doesn't
      // supply them.
      branch_patterns: a.branchPatterns ?? {
        feature: "feat/{issue}-{slug}",
        fix: "fix/{issue}-{slug}",
        chore: "chore/{issue}-{slug}",
        refactor: "refactor/{issue}-{slug}",
        docs: "docs/{issue}-{slug}",
      },
      commits: {
        style: "conventional",
        signed: false,
        scope_source: "primary_area_label",
      },
      pr: {
        title: "{type}: {summary}",
        body_template: `${bundleRef}/templates/pr.md`,
        link_issue_with: "Closes #{issue}",
        request_reviewers: a.reviewers,
        tests_required: ["unit", "integration"],
        e2e_required_on: a.e2eSetup === "none" ? [] : ["ux"],
        self_review_required: true,
        // link_release_umbrella is set to true ONLY when the user
        // configured a release tracker. When `a.releaseTracker` is
        // undefined we emit false so downstream dev-loop's
        // "update the linked umbrella" step never fires even if a
        // future release-tracker appears in the config mid-session.
        link_release_umbrella: Boolean(a.releaseTracker),
        update_plan_oneliner: true,
      },
      release: {
        umbrella_title: "{intent_label_pretty} Release",
      },
      code_review: {
        provider: "ctxr-skill-code-review",
        provider_url: "https://github.com/ctxr-dev/skill-code-review",
        invocation: "/skill-code-review",
        mode: "diff",
        output_format: "markdown",
        report_dir: ".development/shared/reports",
        block_on_verdict: ["NO-GO"],
        install_hint: "npx @ctxr/kit install @ctxr/skill-code-review",
      },
    },
    paths: {
      agent_bundle_dir: bundleRef,
      wrappers: {
        skills_dir: ".claude/skills",
        rules_dir: ".claude/rules",
        marker:
          "<!-- ============ PROJECT OVERRIDES BELOW (preserved across agent updates) ============ -->",
        header_notice:
          "Wrapper file. Canonical content lives in the agent bundle and updates via 'git pull' inside the bundle. Edit below the overrides marker only; everything above is regenerated.",
        preserve_user_below_marker: true,
      },
      plans_root: ".claude/plans",
      plan_states: ["todo", "in-progress", "in-review", "blocked", "done"],
      done_nested: true,
      done_pattern: "done/{yyyy}/{mm}/{dd}/{slug}",
      dev_working_dir: ".development",
      gitignore_dev_working_dir: true,
      dev_working_shared_subdir: "shared",
      dev_working_local_subdir: "local",
      dev_working_cache_subdir: "cache",
      templates: `${bundleRef}/templates`,
      reports: ".development/shared/reports",
      runbooks: ".development/shared/runbooks",
    },
    wiki: {
      provider: "@ctxr/skill-llm-wiki",
      mode: "in-place",
      roots: {
        shared: ".development/shared",
        local: ".development/local",
        cache: ".development/cache",
      },
      shared_topics: ["runbooks", "reports", "plans"],
      required: true,
    },
    stack: {
      language: d.stack.language.length ? d.stack.language : ["other"],
      testing: d.stack.testing,
      platform: d.stack.platform,
    },
    area_keywords: {},
    compliance: {
      regimes: a.regimes,
      data_classes: a.dataClasses,
    },
  };
}

export function cadenceToIntent(cadence) {
  switch (cadence) {
    case "continuous":
      return ["initial", "post-launch"];
    case "per-version":
      return ["initial", "v1", "v2", "v3", "post-launch"];
    case "per-wave":
    default:
      return ["initial", "wave-1", "wave-2", "wave-3", "wave-4", "post-launch"];
  }
}

export function dedupe(arr) {
  return [...new Set(arr)];
}
