#!/usr/bin/env node
// update_self.mjs
// Deterministic, safe upgrade path for the agent bundle regardless of how it
// was installed. Two supported install modes:
//
//   1. git install: the bundle is a git working tree (the ".git" folder
//      exists inside it). Behaviour: fetch origin, enumerate semver tags,
//      checkout the highest (or --tag <name>), and run install.mjs --update
//      to refresh wrappers.
//
//   2. npm install: the bundle was placed by `npm install`/`npx @ctxr/kit`.
//      No ".git" folder. We identify the package name from package.json and
//      run `npm install <name>@latest` in whichever scope the bundle lives
//      (local node_modules or the user-global @ctxr/kit registry).
//
// In both cases the update is two-phase:
//   (a) pull the new bundle contents atomically via git checkout / npm install,
//   (b) re-invoke install.mjs --update so the target project's wrappers are
//       refreshed from the now-current canonical files.
//
// The script never runs blind; it prints what it will do, waits for --apply,
// and exits 0 on no-op (already at latest).
//
// Usage:
//   node update_self.mjs [--dry-run|--apply] [--target <path>] [--tag <name>]
//     [--prerelease] [--verbose]

import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
import { preflight } from "./preflight.mjs";
import { parseArgv, boolFlag } from "./lib/argv.mjs";
import { exists, safeRealpathOrExit } from "./lib/fsx.mjs";

// Strict package-name validator: npm scoped/unscoped lowercase alnum with
// `-`, `_`, `.`, and a single `/` separator for scoped names. Used before any
// child-process interpolation to prevent shell-injection vectors on Windows
// (where `shell: true` is required for npm.cmd).
const NPM_PKG_NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i;

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await main();
}

async function main() {
  await preflight();

  const { flags } = parseArgv(process.argv.slice(2), {
    booleans: new Set(["dry-run", "apply", "prerelease", "verbose", "help"]),
  });
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const BUNDLE_ABS = await safeRealpathOrExit(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "bundle");
  const TARGET = flags.target ? await safeRealpathOrExit(resolve(flags.target), "target") : process.cwd();
  const APPLY = boolFlag(flags, "apply", false);
  const DRY_RUN = !APPLY;
  const VERBOSE = boolFlag(flags, "verbose", false);

  const mode = await detectInstallMode(BUNDLE_ABS);
  process.stdout.write(`update-self\n`);
  process.stdout.write(`bundle: ${BUNDLE_ABS}\n`);
  process.stdout.write(`mode:   ${mode}\n`);
  process.stdout.write(`target: ${TARGET}\n`);
  process.stdout.write(`stage:  ${DRY_RUN ? "dry-run (no changes)" : "apply"}\n\n`);

  let updated = false;
  if (mode === "git") {
    updated = await updateViaGit(BUNDLE_ABS, {
      requestedTag: flags.tag,
      includePrerelease: boolFlag(flags, "prerelease", false),
      apply: APPLY,
      verbose: VERBOSE,
    });
  } else if (mode === "npm") {
    updated = await updateViaNpm(BUNDLE_ABS, { apply: APPLY, verbose: VERBOSE });
  } else {
    process.stderr.write(
      `update-self: cannot detect install mode (no .git and no npm-style package layout).\n` +
        `To update manually:\n` +
        `  - git clone: cd ${BUNDLE_ABS} && git fetch --tags && git checkout <tag>\n` +
        `  - npm:       npx @ctxr/kit install @ctxr/agent-staff-engineer@latest\n`
    );
    process.exit(2);
  }

  if (!updated) {
    process.stdout.write("\nalready at latest version; no wrapper refresh needed.\n");
    return;
  }

  // Phase 2: refresh wrappers in the target project now that canonical files
  // may have changed. install.mjs --update is idempotent.
  process.stdout.write("\nrefreshing wrappers in target project...\n");
  const installScript = join(BUNDLE_ABS, "scripts", "install.mjs");
  const installArgs = ["--target", TARGET, "--update", "--yes"];
  if (DRY_RUN) {
    process.stdout.write(`(dry-run) would run: node ${installScript} ${installArgs.join(" ")}\n`);
    return;
  }
  const res = spawnSync(process.execPath, [installScript, ...installArgs], {
    stdio: "inherit",
    cwd: TARGET,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    process.stderr.write(`\ninstall.mjs --update failed (exit ${res.status}).\n`);
    process.exit(res.status ?? 1);
  }
  process.stdout.write("\nupdate-self complete.\n");
}

function printHelp() {
  process.stdout.write(
    [
      "update_self.mjs  deterministic upgrade for the agent bundle",
      "",
      "Options:",
      "  --target <path>     target project to refresh wrappers in (default: cwd)",
      "  --tag <name>        git mode: checkout this tag instead of the highest semver",
      "  --prerelease        git mode: include prerelease tags (e.g. v1.2.0-rc.1)",
      "  --dry-run           default; print what would happen, make no changes",
      "  --apply             perform the update",
      "  --verbose           show underlying git/npm command output",
      "  --help              this message",
      "",
      "Install-mode detection:",
      "  - '.git' folder inside bundle => git mode",
      "  - otherwise, node_modules layout or standalone package.json => npm mode",
      "",
    ].join("\n")
  );
}

/** Detect how the bundle was installed. */
export async function detectInstallMode(bundleAbs) {
  if (await exists(join(bundleAbs, ".git"))) return "git";
  // If the bundle sits inside a node_modules directory, or its package.json
  // records a resolved registry entry, treat it as npm.
  const pj = await readPackageJson(bundleAbs);
  if (!pj) return "unknown";
  if (bundleAbs.includes(`${process.platform === "win32" ? "\\" : "/"}node_modules${process.platform === "win32" ? "\\" : "/"}`)) {
    return "npm";
  }
  if (pj._resolved || pj._from) return "npm";
  if (pj.name && pj.name.startsWith("@ctxr/")) return "npm";
  return "unknown";
}

async function readPackageJson(dir) {
  try {
    const text = await readFile(join(dir, "package.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Git path: fetch tags, pick the highest semver, check it out. */
async function updateViaGit(bundleAbs, opts) {
  // 1. Fetch remote tags quietly.
  const fetch = runGit(bundleAbs, ["fetch", "--tags", "--quiet", "origin"], opts.verbose);
  if (fetch.status !== 0) {
    process.stderr.write(`git fetch failed:\n${fetch.stderr}\n`);
    return false;
  }

  // 2. Enumerate semver tags.
  const tagsRes = runGit(bundleAbs, ["tag", "--list", "v*"], opts.verbose);
  if (tagsRes.status !== 0) {
    process.stderr.write(`git tag listing failed:\n${tagsRes.stderr}\n`);
    return false;
  }
  const tags = tagsRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?$/.test(s));
  if (tags.length === 0) {
    process.stdout.write("no semver tags on remote; cannot update deterministically.\n");
    return false;
  }

  // 3. Pick the target tag.
  let target = opts.requestedTag;
  if (!target) {
    const candidates = opts.includePrerelease ? tags : tags.filter((t) => !t.includes("-"));
    candidates.sort(semverCompareDesc);
    target = candidates[0];
  }
  if (!target) {
    process.stdout.write("no stable tags available; pass --prerelease to consider pre-release tags.\n");
    return false;
  }

  // 4. Determine current HEAD tag.
  const current = runGit(bundleAbs, ["describe", "--tags", "--exact-match", "HEAD"], opts.verbose);
  const currentTag = current.status === 0 ? current.stdout.trim() : null;
  process.stdout.write(`current: ${currentTag ?? "(detached / branch)"}\n`);
  process.stdout.write(`target:  ${target}\n`);
  if (currentTag === target) return false;

  if (!opts.apply) {
    process.stdout.write(`(dry-run) would run: git checkout ${target}\n`);
    return true;
  }

  // 5. Apply the checkout.
  const checkout = runGit(bundleAbs, ["checkout", "--detach", target], opts.verbose);
  if (checkout.status !== 0) {
    process.stderr.write(`git checkout ${target} failed:\n${checkout.stderr}\n`);
    return false;
  }
  process.stdout.write(`checked out ${target}\n`);
  return true;
}

function runGit(cwd, args, verbose) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (verbose) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  return res;
}

/**
 * Semver descending comparator (highest first). Thin wrapper around the npm
 * `semver` package so we get battle-tested prerelease ranking rather than a
 * hand-rolled implementation.
 */
export function semverCompareDesc(a, b) {
  const pa = parseSemverObject(a);
  const pb = parseSemverObject(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  // semver.compare is ascending; negate for descending.
  return -semver.compare(pa, pb);
}

/** Parsed semver representation retained for tests; preserves prerelease. */
export function parseSemver(tag) {
  const v = parseSemverObject(tag);
  if (!v) return { major: 0, minor: 0, patch: 0, prerelease: "" };
  return {
    major: v.major,
    minor: v.minor,
    patch: v.patch,
    prerelease: (v.prerelease ?? []).join("."),
  };
}

/** Internal: parse a tag that may or may not have a leading "v". */
function parseSemverObject(tag) {
  if (typeof tag !== "string") return null;
  return semver.parse(tag.replace(/^v/, ""), { loose: true }) ?? null;
}

/** npm path: re-install the published package at @latest. */
async function updateViaNpm(bundleAbs, opts) {
  const pj = await readPackageJson(bundleAbs);
  if (!pj?.name) {
    process.stderr.write("update-self: package.json has no `name`, cannot update via npm.\n");
    return false;
  }
  const pkg = pj.name;
  // Validate the package name before ANY child_process interpolation. A malicious
  // package.json could otherwise carry shell metacharacters that would run on
  // win32 where `shell: true` is needed for .cmd shim resolution.
  if (!NPM_PKG_NAME_RE.test(pkg)) {
    process.stderr.write(`update-self: package.json name '${pkg}' does not look like a valid npm identifier; refusing to shell out.\n`);
    return false;
  }
  const installedVersion = pj.version ?? "unknown";

  if (!opts.apply) {
    process.stdout.write(
      `(dry-run) would query npm for latest ${pkg}, then run:\n` +
        `  npm install ${pkg}@latest (in the scope that manages this bundle)\n`
    );
    return true;
  }

  // Query the registry only when applying; dry-run should be side-effect free.
  const view = spawnSync("npm", ["view", pkg, "version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (view.status !== 0) {
    process.stderr.write(`npm view failed (cannot reach registry?):\n${view.stderr}\n`);
    return false;
  }
  const latest = view.stdout.trim();
  process.stdout.write(`installed: ${installedVersion}\n`);
  process.stdout.write(`latest:    ${latest}\n`);
  if (latest === installedVersion) return false;

  const installRes = spawnSync("npm", ["install", `${pkg}@latest`, "--no-audit", "--no-fund"], {
    cwd: dirname(bundleAbs),
    stdio: opts.verbose ? "inherit" : "pipe",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (installRes.status !== 0) {
    process.stderr.write(`npm install ${pkg}@latest failed:\n${installRes.stderr ?? ""}\n`);
    process.stderr.write(
      `Try running it yourself, e.g.:\n  npm install -g ${pkg}@latest\n  or: npx @ctxr/kit install ${pkg}@latest\n`
    );
    return false;
  }
  process.stdout.write(`installed ${pkg}@${latest}\n`);
  return true;
}
