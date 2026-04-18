// install.manifest-rename.test.mjs
// Two invariants for the agent-scoped manifest filename:
//
//   1. A fresh --apply writes `.<scoped-slug>-install-manifest.json` and
//      never creates the legacy generic `.install-manifest.json`.
//   2. An existing legacy `.install-manifest.json` (from a pre-rename
//      install) is read on re-apply and removed after a successful write,
//      so only the new agent-scoped file remains on disk.
//
// Back-compat matters because a real user may re-run --apply/--update
// against a target that still carries the old filename. Losing their
// manifest (or ending up with two manifests that silently diverge) would
// break --uninstall.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
const LEGACY_FILE = ".install-manifest.json";

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
  await rm(join(dest, LEGACY_FILE), { force: true });
  await rm(join(dest, MANIFEST_FILE), { force: true });
  await rm(join(dest, ".bootstrap-answers.json"), { force: true });
  await symlink(join(BUNDLE_SRC, "node_modules"), join(dest, "node_modules"));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("install manifest: fresh apply writes the agent-scoped filename", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "manifest-fresh-"));
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

  it("creates the agent-scoped manifest at .claude/.<scoped>-install-manifest.json", async () => {
    assert.ok(await exists(join(scratch, ".claude", MANIFEST_FILE)));
  });

  it("does not create the legacy generic filename", async () => {
    assert.ok(!(await exists(join(scratch, ".claude", LEGACY_FILE))));
  });
});

describe("install manifest: legacy filename is migrated on re-apply", () => {
  let scratch;
  let installed;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "manifest-migrate-"));
    installed = join(scratch, ".claude/agents/agent-staff-engineer");
    await copyBundle(installed);
    await cp(
      join(installed, "examples/ops.config.example.json"),
      join(scratch, ".claude/ops.config.json"),
    );
    await seedWikiSkillStub(scratch);

    // Simulate a pre-rename install: drop a minimal legacy manifest in
    // place. We do NOT want --apply to overwrite the wrappers on disk with
    // diverged content, so we leave the legacy manifest's `wrappers` empty
    // and only verify filename migration.
    await writeFile(
      join(scratch, ".claude", LEGACY_FILE),
      JSON.stringify(
        {
          version: "0.1.0",
          bundle_root: "legacy-placeholder",
          installed_at: "2026-01-01T00:00:00.000Z",
          wrappers: [],
        },
        null,
        2,
      ),
    );

    const res = spawnSync(
      process.execPath,
      [join(installed, "scripts/install.mjs"), "--target", scratch, "--apply", "--yes"],
      { encoding: "utf8", cwd: scratch, env: { ...process.env, CI: "true" } },
    );
    assert.equal(res.status, 0, `install failed: ${res.stderr || res.stdout}`);
    assert.match(
      res.stdout,
      /migrated legacy manifest/,
      "installer should announce the legacy-manifest migration",
    );
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("writes the new agent-scoped manifest", async () => {
    assert.ok(await exists(join(scratch, ".claude", MANIFEST_FILE)));
  });

  it("removes the legacy manifest", async () => {
    assert.ok(!(await exists(join(scratch, ".claude", LEGACY_FILE))));
  });
});

describe("install manifest: filename shape is dot + scoped slug + -install-manifest.json", () => {
  it("follows the canonical pattern for this bundle's package name", () => {
    // Guard against someone quietly renaming the suffix back to the old
    // generic form, or dropping the leading dot, or changing the slug rule.
    assert.equal(MANIFEST_FILE, `.${MANIFEST_SLUG}-install-manifest.json`);
    assert.ok(MANIFEST_FILE.startsWith("."), "manifest must be a dotfile");
    assert.ok(
      MANIFEST_FILE.endsWith("-install-manifest.json"),
      "manifest must end with -install-manifest.json",
    );
    assert.notEqual(MANIFEST_FILE, LEGACY_FILE, "must not equal the legacy generic filename");
    assert.ok(
      MANIFEST_SLUG.length > 0 && !MANIFEST_SLUG.includes("/") && !MANIFEST_SLUG.startsWith("@"),
      "scoped slug must have no '/' or leading '@'",
    );
  });
});
