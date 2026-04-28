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

  it("emits a file pattern WITHOUT trailing slash when type:'file' is requested", async () => {
    const dir = await makeDir("file-form", "");
    const { added } = await ensureGitignore(dir, [
      { pattern: ".claude/state/knowledge-index.db", type: "file" },
    ]);
    assert.deepEqual(added, ["/.claude/state/knowledge-index.db"]);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(content, /^\/\.claude\/state\/knowledge-index\.db$/m);
    // Crucially: NO trailing slash on the file form.
    assert.doesNotMatch(content, /^\/\.claude\/state\/knowledge-index\.db\/$/m);
  });

  it("re-running with type:'file' is idempotent (no duplicate, no rewrite)", async () => {
    const dir = await makeDir("file-idem", "/.claude/state/knowledge-index.db\n");
    const before = await readFile(join(dir, ".gitignore"), "utf8");
    const { added } = await ensureGitignore(dir, [
      { pattern: ".claude/state/knowledge-index.db", type: "file" },
    ]);
    assert.deepEqual(added, []);
    const after = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal(after, before);
  });

  it("type:'file' adds the file form even if a stale dir-form line for the same path exists", async () => {
    // Defends against a regression: round 18 added a directory-form
    // gitignore call for the SQLite frontier, which (under that
    // version) produced `/.claude/state/knowledge-index.db/`. After
    // round 19 fixed the call to `type: "file"`, an upgrading project
    // could already have the broken dir-form line in its .gitignore.
    // The helper must detect that the existing entry is the wrong
    // KIND and append the correct file-form rule alongside it.
    const dir = await makeDir(
      "file-vs-dir",
      "# pre-existing stale entry from an older installer\n/.claude/state/knowledge-index.db/\n",
    );
    const { added } = await ensureGitignore(dir, [
      { pattern: ".claude/state/knowledge-index.db", type: "file" },
    ]);
    assert.deepEqual(added, ["/.claude/state/knowledge-index.db"]);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    // Both forms now coexist; the file-form actually ignores the file.
    assert.match(content, /^\/\.claude\/state\/knowledge-index\.db\/$/m);
    assert.match(content, /^\/\.claude\/state\/knowledge-index\.db$/m);
  });

  it("rejects malformed entries (non-string, non-object)", async () => {
    const dir = await makeDir("bad", "");
    await assert.rejects(() => ensureGitignore(dir, [42]));
    await assert.rejects(() => ensureGitignore(dir, [{ wrongKey: "x" }]));
    await assert.rejects(() => ensureGitignore(dir, [null]));
  });
});
