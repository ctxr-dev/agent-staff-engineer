// install.code-review-probe.test.mjs
// Coverage of the code-review provider install-time probe (#23).
//   A. ctxr-skill-code-review present → detected, config unchanged.
//   B. ctxr-skill-code-review missing → falls back to internal-template,
//      config updated, stdout notes the fallback.
//   C. provider already CODE_REVIEW_INTERNAL → no probe, no fallback.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedWikiSkillStub } from "./fixtures/wikiSkillStub.mjs";
import { readJsonOrNull } from "../scripts/lib/fsx.mjs";
import { CODE_REVIEW_SKILL, CODE_REVIEW_INTERNAL } from "../scripts/lib/constants.mjs";

const BUNDLE_SRC = dirname(dirname(fileURLToPath(import.meta.url)));

async function copyBundle(dest) {
  await cp(BUNDLE_SRC, dest, {
    recursive: true,
    filter: (src) => {
      if (/\/node_modules(\/|$)/.test(src) || src.endsWith("/node_modules")) return false;
      if (src.endsWith("/.git") || src.includes("/.git/")) return false;
      if (/\/tests(\/|$)/.test(src)) return false;
      return true;
    },
  });
  await rm(join(dest, ".install-manifest.json"), { force: true });
  await rm(join(dest, ".ctxr-agent-staff-engineer-install-manifest.json"), { force: true });
  await rm(join(dest, ".bootstrap-answers.json"), { force: true });
  await symlink(join(BUNDLE_SRC, "node_modules"), join(dest, "node_modules"));
}

function runInstall(installedBundle, target, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(installedBundle, "scripts/install.mjs"), "--target", target, "--apply", "--yes"],
    { encoding: "utf8", env: { ...process.env, CI: "true", ...extraEnv } },
  );
}

async function seedCodeReviewStub(target) {
  const dir = join(target, ".claude", "skills", CODE_REVIEW_SKILL);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "---\nname: code-review-stub\n---\n# Stub\n");
}

describe("install.mjs code-review probe: skill present", () => {
  let scratch;
  let installed;
  let installResult;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "cr-probe-ok-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    await seedWikiSkillStub(scratch);
    await seedCodeReviewStub(scratch);
    // Run install once in setup so tests don't depend on ordering
    const emptyHome = join(scratch, "empty-home");
    installResult = runInstall(installed, scratch, { HOME: emptyHome, USERPROFILE: emptyHome });
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("detects the skill and confirms in stdout", () => {
    assert.equal(installResult.status, 0, `install failed: ${installResult.stderr || installResult.stdout}`);
    assert.match(installResult.stdout, /code-review provider: ctxr-skill-code-review found at/);
  });

  it("leaves ops.config.json provider unchanged", async () => {
    const cfg = await readJsonOrNull(join(scratch, ".claude/ops.config.json"));
    assert.equal(cfg.workflow.code_review.provider, CODE_REVIEW_SKILL);
  });
});

describe("install.mjs code-review probe: skill missing, falls back", () => {
  let scratch;
  let installed;
  let installResult;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "cr-probe-missing-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    await seedWikiSkillStub(scratch);
    // Intentionally skip seedCodeReviewStub
    // Run install once in setup so tests don't depend on ordering
    const emptyHome = join(scratch, "empty-home");
    installResult = runInstall(installed, scratch, { HOME: emptyHome, USERPROFILE: emptyHome });
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("falls back to internal-template and notes it in stdout", () => {
    assert.equal(installResult.status, 0, `install should still succeed: ${installResult.stderr || installResult.stdout}`);
    assert.match(installResult.stdout, /falling back to internal-template/);
  });

  it("updates ops.config.json provider to internal-template", async () => {
    const cfg = await readJsonOrNull(join(scratch, ".claude/ops.config.json"));
    assert.equal(cfg.workflow.code_review.provider, CODE_REVIEW_INTERNAL);
  });
});

describe("install.mjs code-review probe: provider already internal-template", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "cr-probe-skip-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    // Patch the config to use internal-template
    const cfgPath = join(scratch, ".claude/ops.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.workflow.code_review.provider = CODE_REVIEW_INTERNAL;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await seedWikiSkillStub(scratch);
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("skips the probe entirely (no code-review provider message in stdout)", () => {
    const res = runInstall(installed, scratch);
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
    assert.ok(
      !res.stdout.includes("code-review provider:"),
      `should not probe when already internal-template; stdout: ${res.stdout}`,
    );
  });
});
