// install.scenarios.e2e.test.mjs
// Extra E2E scenarios flagged as CRITICAL in iteration 2:
//   * user-global bundle (absolute agent_bundle_dir; bundle lives OUTSIDE TARGET)
//   * CLAUDE.md collision branch (pre-existing user CLAUDE.md must NOT be overwritten)
//   * reinstall-after-uninstall picks up .userkeep.md coexistence
// Each scenario has its own scratch dir under os.tmpdir() and leaves no residue.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedWikiSkillStub } from "./fixtures/wikiSkillStub.mjs";

const BUNDLE_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER =
  "<!-- ============ PROJECT OVERRIDES BELOW (preserved across agent updates) ============ -->";

async function makeBundle(root) {
  await cp(BUNDLE_SRC, root, {
    recursive: true,
    filter: (src) => {
      if (/\/node_modules(\/|$)/.test(src) || src.endsWith("/node_modules")) return false;
      if (src.endsWith("/.git") || src.includes("/.git/")) return false;
      if (/\/tests(\/|$)/.test(src)) return false;
      return true;
    },
  });
  // Wire runtime deps via symlink (production uses npm install under kit).
  await symlink(join(BUNDLE_SRC, "node_modules"), join(root, "node_modules"));
}

function runInstall(bundleRoot, args) {
  const res = spawnSync(
    process.execPath,
    [join(bundleRoot, "scripts/install.mjs"), ...args],
    { encoding: "utf8", env: { ...process.env, CI: "true" } }
  );
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("install e2e: user-global bundle (absolute bundle path)", () => {
  let scratch;
  let bundleRoot;
  let targetRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-global-"));
    bundleRoot = join(scratch, "fake-home", ".claude", "agents", "agent-staff-engineer");
    targetRoot = join(scratch, "my-project");
    await makeBundle(bundleRoot);
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    // Pre-seed ops.config.json so --yes can skip the interactive bootstrap.
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(targetRoot, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(targetRoot);
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("installs with an ABSOLUTE agent_bundle_dir and works end to end", async () => {
    const { code, stdout, stderr } = runInstall(bundleRoot, [
      "--target",
      targetRoot,
      "--apply",
      "--yes",
    ]);
    assert.equal(code, 0, `install --apply failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    // The manifest must live in the TARGET project, not the bundle.
    const manifestText = await readFile(
      join(targetRoot, ".claude/.install-manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestText);
    assert.ok(manifest.wrappers.length > 0);
    // Wrappers must use the ABSOLUTE bundle path in their include instruction,
    // since the bundle sits outside the target.
    const ruleWrapper = await readFile(
      join(targetRoot, ".claude/rules/agent-staff-engineer_pr-workflow.md"),
      "utf8"
    );
    assert.ok(
      ruleWrapper.includes(bundleRoot),
      `expected wrapper to reference absolute bundle path ${bundleRoot}`
    );
  });

  it("--update is idempotent against the same user-global bundle", async () => {
    const { code } = runInstall(bundleRoot, ["--target", targetRoot, "--update", "--yes"]);
    assert.equal(code, 0);
  });
});

describe("install e2e: CLAUDE.md managed-block injection", () => {
  const BEGIN = "<!-- agent-staff-engineer:begin managed block";
  const END = "<!-- agent-staff-engineer:end managed block";

  let scratch;
  let bundleRoot;
  let targetRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-claudemd-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    targetRoot = scratch;
    await makeBundle(bundleRoot);
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(targetRoot, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(targetRoot);
    // User-authored CLAUDE.md predating the agent install. Every byte outside
    // the injected managed block MUST be preserved.
    await writeFile(
      join(targetRoot, "CLAUDE.md"),
      "# My Project\n\nHand-written preamble that must survive.\n\n## House rules\n\n- Be nice.\n"
    );
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("injects the managed block into a pre-existing CLAUDE.md; user content outside is preserved", async () => {
    const { code, stderr } = runInstall(bundleRoot, [
      "--target",
      targetRoot,
      "--apply",
      "--yes",
    ]);
    assert.equal(code, 0, stderr);
    const updated = await readFile(join(targetRoot, "CLAUDE.md"), "utf8");
    // User content is preserved verbatim.
    assert.ok(updated.startsWith("# My Project"));
    assert.ok(updated.includes("Hand-written preamble that must survive"));
    assert.ok(updated.includes("## House rules"));
    // Managed block is appended with both markers present.
    assert.ok(updated.includes(BEGIN), "begin marker must be present");
    assert.ok(updated.includes(END), "end marker must be present");
    // No sidecar file created.
    const rootListing = await readdir(targetRoot);
    assert.ok(!rootListing.includes("CLAUDE.agent.md"), "should NOT create CLAUDE.agent.md");
  });

  it("update refreshes only between markers; user content outside is byte-stable", async () => {
    // Inject an extra user line OUTSIDE the managed block.
    const original = await readFile(join(targetRoot, "CLAUDE.md"), "utf8");
    const bumped = original + "\n\nLate-added user note: survives updates.\n";
    await writeFile(join(targetRoot, "CLAUDE.md"), bumped);

    const { code } = runInstall(bundleRoot, ["--target", targetRoot, "--update", "--yes"]);
    assert.equal(code, 0);
    const refreshed = await readFile(join(targetRoot, "CLAUDE.md"), "utf8");
    assert.ok(
      refreshed.includes("Late-added user note: survives updates."),
      "user content added outside the managed block must survive --update"
    );
    assert.ok(refreshed.includes("# My Project"));
  });

  it("uninstall strips the managed block but keeps user content", async () => {
    const { code } = runInstall(bundleRoot, ["--target", targetRoot, "--uninstall"]);
    assert.equal(code, 0);
    const final = await readFile(join(targetRoot, "CLAUDE.md"), "utf8");
    assert.ok(final.includes("Hand-written preamble that must survive"));
    assert.ok(final.includes("Late-added user note"));
    assert.ok(!final.includes(BEGIN), "managed block should be gone after uninstall");
    assert.ok(!final.includes(END), "managed block should be gone after uninstall");
  });
});

describe("install e2e: CLAUDE.md is a directory (refuses cleanly)", () => {
  let scratch;
  let bundleRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-claudedir-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    await makeBundle(bundleRoot);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(scratch);
    // Collide: make CLAUDE.md a directory.
    await mkdir(join(scratch, "CLAUDE.md"));
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("exits non-zero with a helpful message rather than dumping an ENOENT/EISDIR stack", () => {
    const res = runInstall(bundleRoot, ["--target", scratch, "--apply", "--yes"]);
    assert.notEqual(res.code, 0, "install should refuse when CLAUDE.md is a directory");
    assert.match(res.stderr, /CLAUDE\.md.*directory/i);
  });
});

describe("install e2e: byte-stable CLAUDE.md across consecutive --update runs", () => {
  let scratch;
  let bundleRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-stable-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    await makeBundle(bundleRoot);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(scratch);
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("two consecutive --update runs produce an identical CLAUDE.md sha", async () => {
    runInstall(bundleRoot, ["--target", scratch, "--apply", "--yes"]);
    runInstall(bundleRoot, ["--target", scratch, "--update", "--yes"]);
    const a = await readFile(join(scratch, "CLAUDE.md"), "utf8");
    runInstall(bundleRoot, ["--target", scratch, "--update", "--yes"]);
    const b = await readFile(join(scratch, "CLAUDE.md"), "utf8");
    assert.equal(a, b, "CLAUDE.md content must not drift on a no-op --update");
  });
});

describe("install e2e: manifest records the CLAUDE.md entry (kind='project-claude-md')", () => {
  let scratch;
  let bundleRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-manifest-kind-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    await makeBundle(bundleRoot);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(scratch);
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("writes a `project-claude-md` kind entry so uninstall can find CLAUDE.md", async () => {
    runInstall(bundleRoot, ["--target", scratch, "--apply", "--yes"]);
    const manifest = JSON.parse(
      await readFile(join(scratch, ".claude/.install-manifest.json"), "utf8")
    );
    assert.ok(
      manifest.wrappers.some((w) => w.kind === "project-claude-md"),
      "manifest must contain a project-claude-md entry"
    );
  });
});

describe("install e2e: legacy project-claude-md-alt manifest entry migrates to .userkeep.md", () => {
  let scratch;
  let bundleRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-legacy-alt-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    await makeBundle(bundleRoot);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(scratch);
    // Fake legacy state: a CLAUDE.agent.md sidecar plus a manifest entry
    // with the old kind pointing at it.
    const legacyPath = join(scratch, "CLAUDE.agent.md");
    await writeFile(legacyPath, "# Legacy agent md\n\nsome content from a prior install.\n");
    const manifest = {
      version: "0.1.0",
      installed_at: new Date().toISOString(),
      wrappers: [
        {
          path: legacyPath,
          kind: "project-claude-md-alt",
          canonical: null,
          sha: "deadbeef",
          written_at: new Date().toISOString(),
        },
      ],
    };
    await writeFile(
      join(scratch, ".claude/.install-manifest.json"),
      JSON.stringify(manifest, null, 2)
    );
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("renames legacy CLAUDE.agent.md to .userkeep.md on uninstall", async () => {
    const res = runInstall(bundleRoot, ["--target", scratch, "--uninstall"]);
    assert.equal(res.code, 0, res.stderr);
    const keep = await readFile(join(scratch, "CLAUDE.agent.userkeep.md"), "utf8");
    assert.ok(keep.includes("Legacy agent md"));
    const rootListing = await readdir(scratch);
    assert.ok(
      !rootListing.includes("CLAUDE.agent.md"),
      "legacy sidecar should be renamed, not left behind"
    );
  });
});

describe("install e2e: CLAUDE.md created when missing, removed on clean uninstall", () => {
  let scratch;
  let bundleRoot;
  let targetRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-claudemd-missing-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    targetRoot = scratch;
    await makeBundle(bundleRoot);
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(targetRoot, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(targetRoot);
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("creates CLAUDE.md when missing, then removes it on uninstall (no user content)", async () => {
    let res = runInstall(bundleRoot, ["--target", targetRoot, "--apply", "--yes"]);
    assert.equal(res.code, 0);
    const created = await readFile(join(targetRoot, "CLAUDE.md"), "utf8");
    assert.ok(created.includes("<!-- agent-staff-engineer:begin managed block"));

    res = runInstall(bundleRoot, ["--target", targetRoot, "--uninstall"]);
    assert.equal(res.code, 0);
    const rootListing = await readdir(targetRoot);
    assert.ok(
      !rootListing.includes("CLAUDE.md"),
      "CLAUDE.md should be removed on uninstall when nothing survives outside the managed block"
    );
  });
});

describe("install e2e: reinstall after uninstall picks up .userkeep.md", () => {
  let scratch;
  let bundleRoot;
  let targetRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-reinstall-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    targetRoot = scratch;
    await makeBundle(bundleRoot);
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(targetRoot, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(targetRoot);
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("applies, user edits, uninstalls preserving overrides, then reinstall keeps .userkeep.md", async () => {
    let res = runInstall(bundleRoot, ["--target", targetRoot, "--apply", "--yes"]);
    assert.equal(res.code, 0);

    const rulePath = join(targetRoot, ".claude/rules/agent-staff-engineer_no-dashes.md");
    const existing = await readFile(rulePath, "utf8");
    await writeFile(rulePath, existing + "\n\nCustom override that should survive.\n");

    res = runInstall(bundleRoot, ["--target", targetRoot, "--uninstall"]);
    assert.equal(res.code, 0, res.stderr);

    // User-keep file exists and contains the override.
    const keep = await readFile(
      join(targetRoot, ".claude/rules/agent-staff-engineer_no-dashes.userkeep.md"),
      "utf8"
    );
    assert.ok(keep.includes("Custom override that should survive"));

    // Reinstall does not fail and does not touch the userkeep file.
    res = runInstall(bundleRoot, ["--target", targetRoot, "--apply", "--yes"]);
    assert.equal(res.code, 0, `reinstall failed: ${res.stderr}`);
    const rules = await readdir(join(targetRoot, ".claude/rules"));
    assert.ok(
      rules.includes("agent-staff-engineer_no-dashes.userkeep.md"),
      "userkeep must survive reinstall"
    );
    assert.ok(
      rules.includes("agent-staff-engineer_no-dashes.md"),
      "fresh wrapper must also exist after reinstall"
    );
  });
});

describe("install e2e: prefixed memory-seed wrapper with user overrides is preserved as .userkeep.md", () => {
  let scratch;
  let bundleRoot;
  let targetRoot;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "agent-seed-userkeep-"));
    bundleRoot = join(scratch, ".claude", "agents", "agent-staff-engineer");
    targetRoot = scratch;
    await makeBundle(bundleRoot);
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await cp(
      join(bundleRoot, "examples/ops.config.example.json"),
      join(targetRoot, ".claude/ops.config.json")
    );
    await seedWikiSkillStub(targetRoot);
  });
  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("uninstall of a user-edited prefixed memory seed keeps overrides and preserves the prefix", async () => {
    let res = runInstall(bundleRoot, ["--target", targetRoot, "--apply", "--yes"]);
    assert.equal(res.code, 0, res.stderr);

    // Find any seed wrapper in the memory folder. All must be prefixed.
    const memory = await readdir(join(targetRoot, ".claude/memory"));
    const seed = memory.find((n) => n.startsWith("seed-agent-staff-engineer_") && n.endsWith(".md"));
    assert.ok(seed, `expected at least one prefixed memory seed wrapper; got ${memory.join(", ")}`);

    const seedPath = join(targetRoot, ".claude/memory", seed);
    const existing = await readFile(seedPath, "utf8");
    await writeFile(seedPath, existing + "\n\nPer-project seed override text.\n");

    res = runInstall(bundleRoot, ["--target", targetRoot, "--uninstall"]);
    assert.equal(res.code, 0, res.stderr);

    // Userkeep file must exist, still carry the prefix (renaming preserves
    // everything up to the .md extension), and contain the override.
    const userkeepName = seed.replace(/\.md$/, ".userkeep.md");
    const keep = await readFile(join(targetRoot, ".claude/memory", userkeepName), "utf8");
    assert.ok(
      userkeepName.startsWith("seed-agent-staff-engineer_"),
      `userkeep filename must retain the seed-<prefix>_ convention; got ${userkeepName}`
    );
    assert.ok(keep.includes("Per-project seed override text."));
  });
});
