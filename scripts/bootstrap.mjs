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
import { dirname, join, relative, resolve } from "node:path";
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
 */
export function parseHostKind(url) {
  if (!url) return null;
  const hostMatch = url.match(/^(?:git@|https?:\/\/)([^:/]+)/);
  if (!hostMatch) return null;
  const host = hostMatch[1].toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || host.includes("gitlab")) return "gitlab";
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
  try {
    const r = spawnSync("test", ["-f", path], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function isOnPath(cmd) {
  const r = spawnSync("command", ["-v", cmd], { stdio: "ignore", shell: true });
  return r.status === 0;
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
  process.stdout.write(`  remote host:    ${parseHostKind(d.git.remote) ?? "(unknown / unsupported)"}\n`);
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
  process.stdout.write("Note: the agent's full write surface is implemented for GitHub today; Jira / Linear / GitLab backends accept the config but every write op throws NotSupportedError until their real impls land.\n\n");

  const workTracking = await ask(
    "1. Work tracking style: tracker-issues / tracker-and-local-plans / mixed",
    "tracker-and-local-plans"
  );
  const cadence = await ask(
    "2. Release cadence: continuous / per-wave / per-version / adhoc",
    "per-wave"
  );
  const teamSize = await ask("3. Team size: solo / small (2-5) / larger", "solo");
  const pushAllowedRaw = await ask(
    "   Who may push to the default branch? Comma-separated logins",
    d.gh.login ?? ""
  );
  const reviewersRaw = await ask(
    "   Default reviewers (comma-separated; include 'copilot' if available)",
    [d.gh.login, "copilot"].filter(Boolean).join(",")
  );
  const e2eSetup = await ask(
    "4. e2e setup: none / xcuitest / playwright / cypress / pytest / other",
    d.stack.testing[0] ?? "none"
  );
  const e2ePath = await ask("   e2e scripts path (empty if N/A)", "");

  const inferredKind = inferTrackerKind(d) ?? "github";
  const devKind = await ask(
    "5. Tracker hosting dev issues: github / jira / linear / gitlab",
    inferredKind
  );
  const devTracker = await askTrackerTarget(ask, devKind, "dev", d);

  const releaseKind = await ask(
    "6. Tracker hosting release umbrellas: github / jira / linear / gitlab (default: same as dev)",
    devKind
  );
  const releaseTracker = await askTrackerTarget(ask, releaseKind, "release", d, devTracker);

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
    workTracking,
    cadence,
    teamSize,
    pushAllowed: pushAllowedRaw.split(",").map((s) => s.trim()).filter(Boolean),
    reviewers: reviewersRaw.split(",").map((s) => s.trim()).filter(Boolean),
    e2eSetup,
    e2ePath,
    devTracker,
    releaseTracker,
    observed,
    defaultDepth,
    regimes,
    dataClasses,
    seedProductRules,
  };
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
      const owner = await ask("   GitHub owner", reference?.kind === "github" ? reference.owner : inferredOwner);
      const repo = role === "dev"
        ? await ask("   GitHub repo", reference?.kind === "github" ? reference.repo ?? "" : inferredRepo)
        : await ask("   GitHub repo (optional for release tracker that spans repos)", "");
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
        depth: "full",
        projects,
      };
      if (repo) target.repo = repo;
      return target;
    }
    case "jira": {
      const site = await ask(
        "   Jira site (e.g. acme.atlassian.net)",
        reference?.kind === "jira" ? reference.site : ""
      );
      const project = await ask(
        "   Jira project key (e.g. PLAT)",
        reference?.kind === "jira" ? reference.project : ""
      );
      return {
        kind: "jira",
        site,
        project,
        depth: "full",
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
      const workspace = await ask(
        "   Linear workspace URL key",
        reference?.kind === "linear" ? reference.workspace : ""
      );
      const team = await ask(
        "   Linear team key (2-10 uppercase letters, e.g. ENG)",
        reference?.kind === "linear" ? reference.team : ""
      );
      return {
        kind: "linear",
        workspace,
        team,
        depth: "full",
        status_values: {
          backlog: "Backlog",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
      };
    }
    case "gitlab": {
      const host = await ask(
        "   GitLab host",
        reference?.kind === "gitlab" ? reference.host : "gitlab.com"
      );
      const project_path = await ask(
        "   GitLab project_path (group/subgroup/repo)",
        reference?.kind === "gitlab" ? reference.project_path : ""
      );
      return {
        kind: "gitlab",
        host,
        project_path,
        depth: "full",
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
 */
export function parseObservedGithubRepos(s, depth) {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const [owner, name] = pair.split("/");
      return {
        kind: "github",
        owner,
        repo: name,
        depth,
        projects: [],
      };
    });
}

export function pickDefaults(d) {
  const kind = inferTrackerKind(d) ?? "github";
  const pushAllowed = [d.gh.login, "claude"].filter(Boolean);
  const reviewers = [d.gh.login, "copilot"].filter(Boolean);
  const devTracker = defaultTrackerTarget(kind, "dev", d);
  const releaseTracker = defaultTrackerTarget(kind, "release", d);
  return {
    workTracking: "tracker-and-local-plans",
    cadence: "per-wave",
    teamSize: "solo",
    pushAllowed,
    reviewers,
    e2eSetup: d.stack.testing[0] ?? "none",
    e2ePath: "",
    devTracker,
    releaseTracker,
    observed: [],
    defaultDepth: "full",
    regimes: ["none"],
    dataClasses: ["none"],
    seedProductRules: false,
  };
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
      depth: "full",
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
  if (kind === "jira") {
    return {
      kind: "jira",
      site: "",
      project: "",
      depth: "full",
      status_values: { backlog: "Backlog", in_progress: "In Progress", in_review: "In Review", done: "Done" },
      labels_field: "labels",
    };
  }
  if (kind === "linear") {
    return {
      kind: "linear",
      workspace: "",
      team: "",
      depth: "full",
      status_values: { backlog: "Backlog", in_progress: "In Progress", in_review: "In Review", done: "Done" },
    };
  }
  if (kind === "gitlab") {
    return {
      kind: "gitlab",
      host: "gitlab.com",
      project_path: "",
      depth: "full",
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
    trackers: {
      dev: a.devTracker,
      release: a.releaseTracker,
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
      branch_patterns: {
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
        link_release_umbrella: true,
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
