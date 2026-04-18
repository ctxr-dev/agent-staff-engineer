// install.portable-paths.test.mjs
// The installer-generated wrappers must never embed a raw absolute home
// path (e.g. "/Users/alice/..."). A committed wrapper travels with the
// repo; a literal username breaks every teammate whose username differs.
//
// Covers two setups:
//   A. Bundle lives inside TARGET — wrappers must use a project-relative
//      `source:` (e.g. ".claude/agents/agent-staff-engineer/...").
//   B. Bundle lives under $HOME but outside TARGET — wrappers must use
//      a "~/..." form. We isolate this by pointing HOME at a scratch dir
//      so the real user home is never touched.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedWikiSkillStub } from "./fixtures/wikiSkillStub.mjs";
import { deriveScopedSlug } from "../scripts/lib/agentName.mjs";

const BUNDLE_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_SLUG = deriveScopedSlug(
  JSON.parse(await readFile(join(BUNDLE_SRC, "package.json"), "utf8")).name
);
const MANIFEST_FILE = `.${MANIFEST_SLUG}-install-manifest.json`;

const RAW_HOME_PATH_RE = /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//;

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
  await rm(join(dest, MANIFEST_FILE), { force: true });
  await rm(join(dest, ".bootstrap-answers.json"), { force: true });
  await symlink(join(BUNDLE_SRC, "node_modules"), join(dest, "node_modules"));
}

async function collectWrapperBodies(target) {
  const parts = [];
  for (const sub of [".claude/rules", ".claude/skills", ".claude/memory"]) {
    const dir = join(target, sub);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() && !e.isDirectory()) continue;
      const path = join(dir, e.name, e.isDirectory() ? "SKILL.md" : "");
      try {
        parts.push({ path, body: await readFile(path, "utf8") });
      } catch {
        /* dir without SKILL.md, skip */
      }
    }
  }
  return parts;
}

describe("install.mjs: portable wrapper paths — bundle inside TARGET", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "portable-in-target-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    await seedWikiSkillStub(scratch);
    const res = spawnSync(
      process.execPath,
      [join(installed, "scripts/install.mjs"), "--target", scratch, "--apply", "--yes"],
      { encoding: "utf8", cwd: scratch, env: { ...process.env, CI: "true" } },
    );
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("generated wrappers contain no raw /Users/<name>/ or /home/<name>/ path", async () => {
    const wrappers = await collectWrapperBodies(scratch);
    assert.ok(wrappers.length > 0, "expected at least one wrapper");
    for (const { path, body } of wrappers) {
      const m = body.match(RAW_HOME_PATH_RE);
      assert.equal(m, null, `raw home path in ${path}: ${m?.[0]}`);
    }
  });

  it("wrapper source: lines are project-relative (no leading / or ~)", async () => {
    const wrappers = await collectWrapperBodies(scratch);
    for (const { path, body } of wrappers) {
      const match = body.match(/^source:\s*(\S+)/m);
      if (!match) continue;
      const src = match[1];
      assert.ok(
        !src.startsWith("/") && !src.startsWith("~"),
        `source: in ${path} should be project-relative, got "${src}"`,
      );
    }
  });

  it("install manifest contains no raw /Users/<name>/ or /home/<name>/ path", async () => {
    const manifestPath = join(scratch, ".claude", MANIFEST_FILE);
    const body = await readFile(manifestPath, "utf8");
    const m = body.match(RAW_HOME_PATH_RE);
    assert.equal(m, null, `raw home path in manifest: ${m?.[0]}`);
  });

  it("install manifest wrappers[].path is project-relative", async () => {
    const manifestPath = join(scratch, ".claude", MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.wrappers) && manifest.wrappers.length > 0);
    for (const entry of manifest.wrappers) {
      assert.ok(
        typeof entry.path === "string" &&
          !entry.path.startsWith("/") &&
          !entry.path.startsWith("~"),
        `manifest entry.path should be project-relative, got "${entry.path}"`,
      );
    }
  });
});

describe("install.mjs: portable wrapper paths — bundle under $HOME, outside TARGET", () => {
  let scratch;
  let fakeHome;
  let target;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "portable-user-global-"));
    // Name this "fake-home" (not "home") so the literal path segment
    // cannot itself satisfy the /home/<name>/ regex we also assert on.
    fakeHome = join(scratch, "fake-home");
    target = join(scratch, "project");
    installed = join(fakeHome, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    // Target project is a sibling of the fake home.
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(target, ".claude/ops.config.json"),
    );
    // Stub the provider skill at the user-global kit location so the dep
    // check finds it where real installs would live.
    await seedWikiSkillStub(fakeHome);
    const res = spawnSync(
      process.execPath,
      [join(installed, "scripts/install.mjs"), "--target", target, "--apply", "--yes"],
      {
        encoding: "utf8",
        cwd: target,
        env: { ...process.env, CI: "true", HOME: fakeHome, USERPROFILE: fakeHome },
      },
    );
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("wrapper source: lines begin with '~/' when the bundle is in $HOME outside TARGET", async () => {
    const wrappers = await collectWrapperBodies(target);
    assert.ok(wrappers.length > 0, "expected at least one wrapper");
    let checked = 0;
    for (const { path, body } of wrappers) {
      const match = body.match(/^source:\s*(\S+)/m);
      if (!match) continue;
      const src = match[1];
      assert.ok(
        src.startsWith("~/"),
        `source: in ${path} should start with '~/' when bundle is user-global; got "${src}"`,
      );
      checked++;
    }
    assert.ok(checked > 0, "expected to inspect at least one source: line");
  });

  it("generated wrappers contain no raw /Users/<name>/ or /home/<name>/ path", async () => {
    const wrappers = await collectWrapperBodies(target);
    for (const { path, body } of wrappers) {
      const m = body.match(RAW_HOME_PATH_RE);
      assert.equal(m, null, `raw home path in ${path}: ${m?.[0]}`);
    }
  });

  it("install manifest contains no raw /Users/<name>/ or /home/<name>/ path", async () => {
    const manifestPath = join(target, ".claude", MANIFEST_FILE);
    const body = await readFile(manifestPath, "utf8");
    const m = body.match(RAW_HOME_PATH_RE);
    assert.equal(m, null, `raw home path in manifest: ${m?.[0]}`);
  });

  it("install manifest wrappers[].path is project-relative (target-local)", async () => {
    const manifestPath = join(target, ".claude", MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.wrappers) && manifest.wrappers.length > 0);
    for (const entry of manifest.wrappers) {
      // Wrappers are written inside TARGET, so even when the bundle is
      // user-global, wrappers[].path stays project-relative.
      assert.ok(
        typeof entry.path === "string" &&
          !entry.path.startsWith("/") &&
          !entry.path.startsWith("~"),
        `manifest entry.path should be project-relative, got "${entry.path}"`,
      );
    }
  });
});
