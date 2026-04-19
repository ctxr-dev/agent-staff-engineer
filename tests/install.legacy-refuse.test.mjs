// install.legacy-refuse.test.mjs
// Hard-break check: install.mjs must refuse to proceed when it finds
// an ops.config.json still using the pre-trackers top-level `github:`
// block. It should write a timestamped backup alongside the original,
// leave the original untouched, and exit non-zero with a message
// pointing the user at the remediation (delete + re-bootstrap).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_SRC = dirname(dirname(fileURLToPath(import.meta.url)));

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
  await symlink(join(BUNDLE_SRC, "node_modules"), join(root, "node_modules"));
}

function runInstall(bundleRoot, target, extraArgs = []) {
  const res = spawnSync(
    process.execPath,
    [join(bundleRoot, "scripts/install.mjs"), "--target", target, ...extraArgs],
    { encoding: "utf8", env: { ...process.env, CI: "true" } }
  );
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("install: legacy `github:` config shape is hard-refused", () => {
  let scratch, bundleRoot, targetRoot, configPath, originalContent;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "install-legacy-"));
    bundleRoot = join(scratch, "bundle");
    targetRoot = join(scratch, "target");
    await mkdir(bundleRoot, { recursive: true });
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await makeBundle(bundleRoot);

    // Seed a legacy-shaped config that passes JSON parsing but uses
    // the retired `github:` block. The installer's gate fires before
    // schema validation, so the exact contents don't need to satisfy
    // the old schema; only the presence of `github` and absence of
    // `trackers` matter.
    configPath = join(targetRoot, ".claude/ops.config.json");
    originalContent = JSON.stringify(
      {
        $schemaVersion: "0.1.0",
        project: { name: "legacy", repo: "acme/legacy", default_branch: "main" },
        github: { auth_login: "somebody", dev_projects: [], release_projects: [] },
      },
      null,
      2,
    );
    await writeFile(configPath, originalContent, "utf8");
  });

  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("exits non-zero with a clear remediation message naming the exact re-run invocation", () => {
    const { code, stderr } = runInstall(bundleRoot, targetRoot, ["--apply"]);
    assert.notEqual(code, 0, "install must refuse to proceed on legacy shape");
    assert.match(stderr, /legacy 'github:' shape/);
    assert.match(stderr, /trackers:/);
    // Round-14 T2: remediation must include the full invocation so a
    // copy-paste re-run actually works. Specifically: `node`, the
    // absolute path to install.mjs, `--target` with the target's
    // absolute path, and `--apply`. Previously said "install.mjs
    // --apply" alone, which assumed the user knew the bundle location
    // and that install.mjs was a Node script.
    assert.match(stderr, /node .*install\.mjs --target .* --apply/);
    // Also: the message explicitly tells the user to rm the config
    // before re-running, so the command they paste actually regenerates
    // instead of hitting the same refuse gate a second time.
    assert.match(stderr, /rm .*ops\.config\.json/);
  });

  it("writes a .pre-trackers-<ts>-pid<pid>[-<counter>].bak backup alongside the original", async () => {
    // Naming shape (see scripts/install.mjs): the stamp is a filename-
    // safe ISO 8601 (colons/dots replaced with dashes), pid keeps two
    // parallel installs from colliding, and an optional -<counter>
    // suffix (added only when a candidate path already exists) keeps
    // even an absurd 1000-way collision distinct. The regex here
    // deliberately matches any suffix combination so a future tweak to
    // the counter scheme won't silently break this test.
    const entries = await readdir(join(targetRoot, ".claude"));
    const backup = entries.find((n) => /^ops\.config\.json\.pre-trackers-.+\.bak$/.test(n));
    assert.ok(backup, `expected a backup file, got: ${entries.join(", ")}`);
    // Sanity: the filename must contain a pid marker so a regression
    // that dropped the uniqueness suffix (round-3 T2) would fail here.
    assert.match(backup, /-pid\d+/, `expected '-pid<pid>' in the backup filename, got: ${backup}`);
    const backupText = await readFile(join(targetRoot, ".claude", backup), "utf8");
    // Backup round-trips JSON; bytes may reformat but content is equal.
    assert.deepEqual(JSON.parse(backupText), JSON.parse(originalContent));
  });

  it("leaves the original ops.config.json untouched", async () => {
    const current = await readFile(configPath, "utf8");
    assert.equal(current, originalContent);
  });

  it("survives a second invocation by writing a distinct backup (not clobbering the first)", async () => {
    const beforeFiles = new Set(await readdir(join(targetRoot, ".claude")));
    const beforeBackups = [...beforeFiles].filter((n) =>
      /^ops\.config\.json\.pre-trackers-.+\.bak$/.test(n),
    );
    assert.ok(beforeBackups.length >= 1, "precondition: at least one backup from earlier test");

    // Sleep to guarantee a distinct second timestamp. 1.1s is enough
    // because the stamp uses millisecond precision (new Date().toISOString())
    // but any whitespace slop across systems is forgiven by the >= check.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { code } = runInstall(bundleRoot, targetRoot, ["--apply"]);
    assert.notEqual(code, 0);

    const afterFiles = new Set(await readdir(join(targetRoot, ".claude")));
    const afterBackups = [...afterFiles].filter((n) =>
      /^ops\.config\.json\.pre-trackers-.+\.bak$/.test(n),
    );
    assert.ok(
      afterBackups.length > beforeBackups.length,
      `second refuse should create an additional distinct backup; before=${beforeBackups.length}, after=${afterBackups.length}`,
    );
  });
});
