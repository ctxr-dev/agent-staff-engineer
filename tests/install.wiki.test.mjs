// install.wiki.test.mjs
// End-to-end coverage of the wiki-provider dep check and topic folder
// pre-seed. Covers three scenarios:
//   A. wiki.required: true with the provider stub present → install succeeds
//      and the configured topic folders are created under shared/.
//   B. wiki.required: true without the provider present → install exits
//      non-zero with a remediation message naming the install command.
//   C. wiki.required: false → install succeeds even with no provider.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedWikiSkillStub } from "./fixtures/wikiSkillStub.mjs";

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

describe("install.mjs wiki integration: dep check passes when stub present", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "wiki-ok-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    await seedWikiSkillStub(scratch);
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("installs cleanly and pre-seeds the configured shared topic folders", async () => {
    const res = runInstall(installed, scratch);
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
    for (const topic of ["runbooks", "reports", "plans"]) {
      const st = await stat(join(scratch, ".development/shared", topic));
      assert.ok(st.isDirectory(), `expected topic dir .development/shared/${topic}`);
    }
    // README points at the wiki skill and the wiki rule.
    const readme = await readFile(join(scratch, ".development/shared/README.md"), "utf8");
    assert.match(readme, /@ctxr\/skill-llm-wiki/);
    assert.match(readme, /agent-staff-engineer_llm-wiki\.md/);
  });

  it("stdout confirms the wiki provider was located", () => {
    const res = runInstall(installed, scratch);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /wiki provider: @ctxr\/skill-llm-wiki found at/);
  });
});

describe("install.mjs wiki integration: dep check accepts .agents/skills layout", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "wiki-agents-layout-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    // Install the provider stub under .agents/skills/ (open-standard parallel)
    // and NOT under .claude/skills/, to prove the probe covers both.
    await seedWikiSkillStub(scratch, "agents-skills");
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("installs cleanly when the provider lives only in .agents/skills/", () => {
    // Also point HOME at an empty dir so the user-global candidate is empty.
    const emptyHome = join(scratch, "no-home");
    const res = runInstall(installed, scratch, { HOME: emptyHome, USERPROFILE: emptyHome });
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
    assert.match(
      res.stdout,
      /wiki provider: @ctxr\/skill-llm-wiki found at .*\.agents\/skills\/ctxr-skill-llm-wiki/,
      `stdout should report discovery under .agents/skills/; got: ${res.stdout}`,
    );
  });
});

describe("install.mjs wiki integration: dep check fails when stub missing", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "wiki-missing-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    // Intentionally skip seedWikiSkillStub; force HOME to an empty dir so
    // the user-global candidate is also empty.
    const emptyHome = join(scratch, "empty-home");
    await rm(emptyHome, { recursive: true, force: true });
    // mkdir is handled by the test runtime via other operations; ensure it exists.
    await symlink(emptyHome, join(scratch, ".empty-home-marker")).catch(() => {});
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("exits non-zero with a remediation message", async () => {
    const emptyHome = join(scratch, "empty-home");
    await cp(BUNDLE_SRC, emptyHome, { recursive: true, filter: () => false }).catch(() => {});
    const res = runInstall(installed, scratch, { HOME: emptyHome, USERPROFILE: emptyHome });
    assert.notEqual(res.status, 0, "installer should refuse to apply");
    assert.match(
      res.stderr,
      /requires the wiki provider skill '@ctxr\/skill-llm-wiki'/,
      `stderr should name the missing skill; got: ${res.stderr}`,
    );
    assert.match(
      res.stderr,
      /npx @ctxr\/kit install @ctxr\/skill-llm-wiki/,
      `stderr should name the install command`,
    );
  });
});

describe("install.mjs wiki integration: wiki.required=false skips dep check", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "wiki-optout-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    // Start from the example, then flip wiki.required to false.
    const examplePath = join(installed, "examples/ops.config.example.json");
    const configPath = join(scratch, ".claude/ops.config.json");
    const example = JSON.parse(await readFile(examplePath, "utf8"));
    example.wiki.required = false;
    await cp(examplePath, configPath); // ensures the target dir chain exists
    await writeFile(configPath, JSON.stringify(example, null, 2));
    // No skill stub, no HOME override needed.
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("installs successfully without the provider skill present", () => {
    // Point HOME at an empty scratch subdir to be sure no real user-global
    // install accidentally satisfies the check.
    const emptyHome = join(scratch, "no-home");
    const res = runInstall(installed, scratch, { HOME: emptyHome, USERPROFILE: emptyHome });
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
    // Without the dep check, there's no "wiki provider: found" log line.
    assert.doesNotMatch(res.stdout, /wiki provider: .* found at/);
  });
});
