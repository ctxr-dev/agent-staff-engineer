// install.e2e.test.mjs
// End-to-end install cycle: apply -> simulate user override -> update -> uninstall.
// Every filesystem effect is isolated under a scratch directory in os.tmpdir().
// The test never touches any real project, never runs gh, and never hits the
// network. `install.mjs` runs with --yes so bootstrap.mjs takes all defaults
// and no prompts fire.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile, symlink as _symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_SRC = dirname(dirname(fileURLToPath(import.meta.url))); // repo root
const MARKER =
  "<!-- ============ PROJECT OVERRIDES BELOW (preserved across agent updates) ============ -->";

let scratch;
let installed;

function runInstall(args) {
  const res = spawnSync(
    process.execPath,
    [join(installed, "scripts/install.mjs"), ...args],
    { encoding: "utf8", cwd: scratch, env: { ...process.env, CI: "true" } }
  );
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "agent-e2e-"));
  // Simulate a kit install that places the bundle at .claude/agents/agent-staff-engineer/.
  installed = join(scratch, ".claude/agents/agent-staff-engineer");
  await cp(BUNDLE_SRC, installed, {
    recursive: true,
    filter: (src) => {
      // Skip node_modules (the dir itself and anything under it) plus .git
      // and the tests folder.
      if (/\/node_modules(\/|$)/.test(src) || src.endsWith("/node_modules")) return false;
      if (src.endsWith("/.git") || src.includes("/.git/")) return false;
      if (/\/tests(\/|$)/.test(src)) return false;
      return true;
    },
  });
  // Strip any install artefacts that might have snuck in via cp.
  await rm(join(installed, ".install-manifest.json"), { force: true });
  await rm(join(installed, ".bootstrap-answers.json"), { force: true });
  // Symlink node_modules from the source bundle so runtime deps (ajv, gray-matter, diff)
  // are available inside the installed copy. In production, `npm install` happens via
  // kit; in the test we short-circuit with a symlink since we already installed once.
  const { symlink } = await import("node:fs/promises");
  await symlink(join(BUNDLE_SRC, "node_modules"), join(installed, "node_modules"));
  // Seed ops.config.json directly from the example so --yes install can proceed
  // without running the interactive bootstrap (which expects a terminal).
  await cp(join(installed, "examples/ops.config.example.json"), join(scratch, ".claude/ops.config.json"), {
    recursive: false,
  });
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("install.mjs end-to-end", () => {
  it("dry-run prints a plan and writes no wrappers", () => {
    const { code, stdout } = runInstall(["--target", scratch]);
    assert.equal(code, 0);
    assert.match(stdout, /dry-run/);
    assert.match(stdout, /would be written/);
  });

  it("--apply creates skill, rule, and memory wrappers", async () => {
    const { code, stdout } = runInstall(["--target", scratch, "--apply", "--yes"]);
    assert.equal(code, 0, `install --apply failed: ${stdout}`);
    const skills = await readdir(join(scratch, ".claude/skills"));
    assert.ok(skills.length >= 6, `expected skill wrappers, got ${skills}`);
    const rules = await readdir(join(scratch, ".claude/rules"));
    assert.ok(rules.length >= 6, `expected rule wrappers, got ${rules}`);
    const memory = await readdir(join(scratch, ".claude/memory"));
    assert.ok(memory.some((n) => n.endsWith(".md")), `expected memory wrappers, got ${memory}`);
    // Manifest lives in the TARGET project (not inside the bundle) so that
    // user-global / shared bundles don't have per-project state bleed.
    const manifest = JSON.parse(
      await readFile(join(scratch, ".claude", ".install-manifest.json"), "utf8")
    );
    assert.ok(manifest.wrappers.length >= 13, `manifest is too small: ${manifest.wrappers.length}`);
    assert.ok(
      manifest.wrappers.some((w) => w.kind === "memory-seed-wrapper"),
      "manifest must contain memory-seed-wrapper entries so uninstall cleans them"
    );
  });

  it("--apply creates .development/ with shared, local, cache subtrees; only local/cache are gitignored", async () => {
    // All three subtrees exist as directories.
    for (const sub of ["shared", "local", "cache"]) {
      const st = await stat(join(scratch, ".development", sub));
      assert.ok(st.isDirectory(), `.development/${sub} should be a directory`);
    }
    // shared/ carries a first-time README so the team knows what commits where.
    const sharedReadme = await readFile(join(scratch, ".development/shared/README.md"), "utf8");
    assert.match(sharedReadme, /shared/i, "shared README should describe the shared folder");
    // .gitignore contains ONLY local/ and cache/, never a blanket .development/.
    const gi = await readFile(join(scratch, ".gitignore"), "utf8");
    assert.match(gi, /\.development\/local\//, "gitignore must list .development/local/");
    assert.match(gi, /\.development\/cache\//, "gitignore must list .development/cache/");
    // Look for a line that is exactly ".development/" or "/.development/" (blanket);
    // those would wipe out the shared/ commit policy.
    const blanket = gi
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .some((l) => l === ".development/" || l === "/.development/" || l === ".development" || l === "/.development");
    assert.ok(!blanket, "gitignore must NOT ignore all of .development/ (shared/ commits)");
  });

  it("wrapper filenames are prefixed with the agent name", async () => {
    const rules = await readdir(join(scratch, ".claude/rules"));
    assert.ok(
      rules.every((n) => n.startsWith("agent-staff-engineer_") || n.endsWith(".userkeep.md")),
      `every rule wrapper should carry the agent-staff-engineer_ prefix; got ${rules.join(", ")}`
    );
    const skills = await readdir(join(scratch, ".claude/skills"));
    assert.ok(
      skills.every((n) => n.startsWith("agent-staff-engineer_")),
      `every skill wrapper should carry the agent-staff-engineer_ prefix; got ${skills.join(", ")}`
    );
    const memory = await readdir(join(scratch, ".claude/memory"));
    const seedFiles = memory.filter((n) => n.startsWith("seed-"));
    assert.ok(seedFiles.length > 0, "at least one memory seed wrapper should exist");
    assert.ok(
      seedFiles.every((n) => n.startsWith("seed-agent-staff-engineer_")),
      `every memory seed wrapper should carry the seed-agent-staff-engineer_ prefix; got ${seedFiles.join(", ")}`
    );
  });

  it("--update preserves below-marker user overrides byte-for-byte", async () => {
    const rulePath = join(scratch, ".claude/rules/agent-staff-engineer_pr-workflow.md");
    const existing = await readFile(rulePath, "utf8");
    const override = "\n\nCustom project override: do not merge PRs on Fridays.\n";
    await writeFile(rulePath, existing + override);

    const { code, stdout } = runInstall(["--target", scratch, "--update", "--yes"]);
    assert.equal(code, 0, `update failed: ${stdout}`);

    const refreshed = await readFile(rulePath, "utf8");
    assert.ok(
      refreshed.includes("Custom project override: do not merge PRs on Fridays."),
      "below-marker override should survive --update"
    );
    // Above-marker section still starts with the refreshed frontmatter.
    assert.ok(refreshed.startsWith("---\n"), "refreshed above-marker must begin with frontmatter");
    // Marker still present exactly once at the split point (user did not paste it a second time).
    const markerCount = refreshed.split(MARKER).length - 1;
    assert.equal(markerCount, 1, `expected exactly one marker, found ${markerCount}`);
  });

  it("--update is idempotent on unchanged state", async () => {
    // With no user edits since the last update, a second --update should produce no diff.
    const rulePath = join(scratch, ".claude/rules/agent-staff-engineer_no-dashes.md");
    const before = await readFile(rulePath, "utf8");
    runInstall(["--target", scratch, "--update", "--yes"]);
    const after = await readFile(rulePath, "utf8");
    assert.equal(after, before, "idempotent --update should not rewrite an untouched wrapper");
  });

  it("--update preserves .development/ layout byte-stably (README + dirs + .gitignore)", async () => {
    // Refactor invariant: --update must NOT rewrite the shared README or
    // append duplicate entries to .gitignore. It must also NOT drop the
    // three subtrees. We compare file bytes before and after a second update.
    const readmePath = join(scratch, ".development/shared/README.md");
    const giPath = join(scratch, ".gitignore");
    const readmeBefore = await readFile(readmePath, "utf8");
    const giBefore = await readFile(giPath, "utf8");

    const { code } = runInstall(["--target", scratch, "--update", "--yes"]);
    assert.equal(code, 0);

    for (const sub of ["shared", "local", "cache"]) {
      const st = await stat(join(scratch, ".development", sub));
      assert.ok(st.isDirectory(), `.development/${sub} should still be a directory after --update`);
    }
    const readmeAfter = await readFile(readmePath, "utf8");
    const giAfter = await readFile(giPath, "utf8");
    assert.equal(readmeAfter, readmeBefore, "shared README must be byte-stable across --update");
    assert.equal(giAfter, giBefore, ".gitignore must be byte-stable across --update (no duplicates)");
  });

  it("--uninstall removes wrappers and preserves user-modified ones as .userkeep.md", async () => {
    const { code, stdout } = runInstall(["--target", scratch, "--uninstall"]);
    assert.equal(code, 0, `uninstall failed: ${stdout}`);
    // The prefixed pr-workflow wrapper carries user overrides from the previous
    // test; it should have been preserved as <prefix>_pr-workflow.userkeep.md.
    const rules = await readdir(join(scratch, ".claude/rules"));
    assert.ok(
      rules.some((n) => n === "agent-staff-engineer_pr-workflow.userkeep.md"),
      `expected agent-staff-engineer_pr-workflow.userkeep.md to preserve overrides; got ${rules}`
    );
    // No stale regular wrappers left behind.
    assert.ok(
      !rules.some((n) => n === "agent-staff-engineer_pr-workflow.md"),
      "regular prefixed pr-workflow wrapper should be removed"
    );
  });

  it("handles a wrapper whose marker was deleted: does not clobber user content", async () => {
    // Fresh apply in a NEW scratch dir so we don't fight the previous test's uninstall.
    const scratch2 = await mkdtemp(join(tmpdir(), "agent-e2e-marker-"));
    const installed2 = join(scratch2, ".claude/agents/agent-staff-engineer");
    await cp(BUNDLE_SRC, installed2, {
      recursive: true,
      filter: (src) => {
        if (/\/node_modules(\/|$)/.test(src) || src.endsWith("/node_modules")) return false;
        if (src.endsWith("/.git") || src.includes("/.git/")) return false;
        if (/\/tests(\/|$)/.test(src)) return false;
        return true;
      },
    });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(BUNDLE_SRC, "node_modules"), join(installed2, "node_modules"));
    await cp(join(installed2, "examples/ops.config.example.json"), join(scratch2, ".claude/ops.config.json"));

    const applyRes = spawnSync(
      process.execPath,
      [join(installed2, "scripts/install.mjs"), "--target", scratch2, "--apply", "--yes"],
      { encoding: "utf8", env: { ...process.env, CI: "true" } }
    );
    assert.equal(applyRes.status, 0, applyRes.stderr);

    // Strip the marker line entirely from a rule wrapper, keep custom content.
    const rulePath = join(scratch2, ".claude/rules/agent-staff-engineer_no-dashes.md");
    const existing = await readFile(rulePath, "utf8");
    const withoutMarker = existing.replace(MARKER + "\n", "") + "\nUser content that must survive.\n";
    await writeFile(rulePath, withoutMarker);

    const upd = spawnSync(
      process.execPath,
      [join(installed2, "scripts/install.mjs"), "--target", scratch2, "--update", "--yes"],
      { encoding: "utf8", env: { ...process.env, CI: "true" } }
    );
    assert.equal(upd.status, 0, `update failed: ${upd.stderr}`);
    const refreshed = await readFile(rulePath, "utf8");
    assert.ok(
      refreshed.includes("User content that must survive"),
      "marker-less user content must be preserved"
    );
    await rm(scratch2, { recursive: true, force: true });
  });

  it("preserves user content even when the wrapper has a second (user-pasted) marker", async () => {
    const scratch3 = await mkdtemp(join(tmpdir(), "agent-e2e-double-"));
    const installed3 = join(scratch3, ".claude/agents/agent-staff-engineer");
    await cp(BUNDLE_SRC, installed3, {
      recursive: true,
      filter: (src) => {
        if (/\/node_modules(\/|$)/.test(src) || src.endsWith("/node_modules")) return false;
        if (src.endsWith("/.git") || src.includes("/.git/")) return false;
        if (/\/tests(\/|$)/.test(src)) return false;
        return true;
      },
    });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(BUNDLE_SRC, "node_modules"), join(installed3, "node_modules"));
    await cp(join(installed3, "examples/ops.config.example.json"), join(scratch3, ".claude/ops.config.json"));

    const applyRes = spawnSync(
      process.execPath,
      [join(installed3, "scripts/install.mjs"), "--target", scratch3, "--apply", "--yes"],
      { encoding: "utf8", env: { ...process.env, CI: "true" } }
    );
    assert.equal(applyRes.status, 0, applyRes.stderr);

    const rulePath = join(scratch3, ".claude/rules/agent-staff-engineer_review-loop.md");
    const existing = await readFile(rulePath, "utf8");
    const withExtraMarker =
      existing + "\nUser line 1\n" + MARKER + "\n(user-pasted marker)\nUser line 2\n";
    await writeFile(rulePath, withExtraMarker);

    const upd = spawnSync(
      process.execPath,
      [join(installed3, "scripts/install.mjs"), "--target", scratch3, "--update", "--yes"],
      { encoding: "utf8", env: { ...process.env, CI: "true" } }
    );
    assert.equal(upd.status, 0, upd.stderr);
    const refreshed = await readFile(rulePath, "utf8");
    assert.ok(refreshed.includes("User line 1"));
    assert.ok(refreshed.includes("User line 2"));
    assert.ok(refreshed.includes("(user-pasted marker)"));
    await rm(scratch3, { recursive: true, force: true });
  });

  it("--uninstall removes memory wrappers too (they are in the manifest)", async () => {
    // This runs after the --uninstall above; memory dir should be empty or only
    // contain non-wrapper files. We assert no `seed-*.md` files remain.
    const memDir = join(scratch, ".claude/memory");
    let memory = [];
    try {
      memory = await readdir(memDir);
    } catch (e) {
      if (e && e.code === "ENOENT") memory = [];
      else throw e;
    }
    const leftovers = memory.filter((n) => n.startsWith("seed-"));
    assert.deepEqual(
      leftovers,
      [],
      `memory wrappers should be removed by uninstall, found: ${leftovers.join(",")}`
    );
  });
});
