import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore, normalisePattern, isListed } from "../scripts/lib/gitignore.mjs";

const scratch = await mkdtemp(join(tmpdir(), "gitignore-test-"));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function makeDir(sub, initialGitignore) {
  const dir = join(scratch, sub);
  await mkdir(dir, { recursive: true });
  if (initialGitignore != null) await writeFile(join(dir, ".gitignore"), initialGitignore);
  return dir;
}

describe("gitignore.normalisePattern", () => {
  it("strips leading and trailing slashes", () => {
    assert.equal(normalisePattern("/.development/"), ".development");
    assert.equal(normalisePattern(".development"), ".development");
    assert.equal(normalisePattern("//foo//"), "foo");
  });

  it("returns empty for non-string input", () => {
    assert.equal(normalisePattern(null), "");
    assert.equal(normalisePattern(undefined), "");
  });
});

describe("gitignore.isListed", () => {
  it("matches all canonical shapes", () => {
    const targets = ["/.development/", "/.development", ".development/", ".development"];
    for (const form of targets) {
      assert.ok(isListed(`# header\n${form}\n`, ".development"), `form "${form}" should match`);
    }
  });

  it("ignores comments appended to lines", () => {
    assert.ok(isListed(".development/ # agent dir\n", ".development"));
  });

  it("returns false for unrelated entries", () => {
    assert.ok(!isListed("node_modules/\n.dist/\n", ".development"));
  });
});

describe("gitignore.ensureGitignore", () => {
  it("appends a single entry when file does not exist", async () => {
    const dir = await makeDir("a", null);
    const { added } = await ensureGitignore(dir, ".development/local");
    assert.deepEqual(added, ["/.development/local/"]);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(content, /\/\.development\/local\//);
  });

  it("appends multiple entries in a single call", async () => {
    const dir = await makeDir("multi", null);
    const { added } = await ensureGitignore(dir, [".development/local", ".development/cache"]);
    assert.deepEqual(added, ["/.development/local/", "/.development/cache/"]);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(content, /\/\.development\/local\//);
    assert.match(content, /\/\.development\/cache\//);
  });

  it("does not duplicate when entry already exists with no trailing slash", async () => {
    const dir = await makeDir("b", ".development/local\n");
    const { added } = await ensureGitignore(dir, ".development/local");
    assert.deepEqual(added, []);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal((content.match(/\.development\/local/g) ?? []).length, 1);
  });

  it("does not duplicate when entry has leading slash and no trailing slash", async () => {
    const dir = await makeDir("c", "/.development/local\n");
    const { added } = await ensureGitignore(dir, ".development/local");
    assert.deepEqual(added, []);
  });

  it("appends with a newline separator when file lacks trailing newline", async () => {
    const dir = await makeDir("d", "node_modules");
    await ensureGitignore(dir, ".development/local");
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.ok(content.includes("node_modules\n/.development/local/"));
  });

  it("does not duplicate when an entry has a trailing comment", async () => {
    const dir = await makeDir("e", ".development/local/ # per-user work\n");
    const { added } = await ensureGitignore(dir, ".development/local");
    assert.deepEqual(added, []);
  });

  it("adds only the missing entries when some are already present", async () => {
    const dir = await makeDir("mixed", "/.development/local/\n");
    const { added } = await ensureGitignore(dir, [".development/local", ".development/cache"]);
    assert.deepEqual(added, ["/.development/cache/"]);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal((content.match(/\.development\/local/g) ?? []).length, 1);
  });

  it("does not rewrite .gitignore when every array entry is already listed", async () => {
    const dir = await makeDir("all-present", "/.development/local/\n/.development/cache/\n");
    const before = await readFile(join(dir, ".gitignore"), "utf8");
    const { added } = await ensureGitignore(dir, [".development/local", ".development/cache"]);
    assert.deepEqual(added, []);
    const after = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal(after, before, "file must be byte-stable when there is nothing to add");
  });
});
