import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteText,
  atomicWriteJson,
  ensureDir,
  exists,
  readJsonOrNull,
  readTextOrNull,
  walkFiles,
  sha256,
} from "../scripts/lib/fsx.mjs";

const scratch = await mkdtemp(join(tmpdir(), "fsx-test-"));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("fsx.atomicWriteText", () => {
  it("creates parent directories and writes content", async () => {
    const p = join(scratch, "deep/nested/file.txt");
    await atomicWriteText(p, "hello");
    assert.equal(await readFile(p, "utf8"), "hello");
  });

  it("leaves no .tmp-* file behind after success", async () => {
    const dir = join(scratch, "clean");
    await ensureDir(dir);
    await atomicWriteText(join(dir, "a.txt"), "ok");
    const entries = await readdir(dir);
    assert.ok(entries.every((e) => !e.includes(".tmp-")), `stale tmp in ${entries.join(",")}`);
  });
});

describe("fsx.atomicWriteJson", () => {
  it("writes pretty-printed JSON with trailing newline", async () => {
    const p = join(scratch, "obj.json");
    await atomicWriteJson(p, { a: 1, b: [2, 3] });
    const text = await readFile(p, "utf8");
    assert.match(text, /\n$/);
    assert.deepEqual(JSON.parse(text), { a: 1, b: [2, 3] });
  });
});

describe("fsx.readJsonOrNull", () => {
  it("returns null for missing files", async () => {
    assert.equal(await readJsonOrNull(join(scratch, "nope.json")), null);
  });

  it("parses valid JSON files", async () => {
    const p = join(scratch, "ok.json");
    await writeFile(p, '{"k": "v"}');
    assert.deepEqual(await readJsonOrNull(p), { k: "v" });
  });

  it("throws a path-aware error on invalid JSON", async () => {
    const p = join(scratch, "bad.json");
    await writeFile(p, "{not json");
    await assert.rejects(() => readJsonOrNull(p), /Invalid JSON in/);
  });
});

describe("fsx.readTextOrNull", () => {
  it("returns null for missing files without throwing", async () => {
    assert.equal(await readTextOrNull(join(scratch, "missing.txt")), null);
  });
});

describe("fsx.walkFiles", () => {
  it("yields files but skips hidden entries by default", async () => {
    const dir = join(scratch, "walkable");
    await ensureDir(dir);
    await writeFile(join(dir, "a.md"), "");
    await writeFile(join(dir, ".hidden"), "");
    await ensureDir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.md"), "");
    const found = [];
    for await (const fp of walkFiles(dir)) found.push(fp);
    assert.ok(found.some((p) => p.endsWith("a.md")), "expected a.md");
    assert.ok(found.some((p) => p.endsWith("b.md")), "expected b.md");
    assert.ok(!found.some((p) => p.endsWith(".hidden")), "should skip hidden entries");
  });

  it("does not infinite-loop on a symlink cycle", async () => {
    const dir = join(scratch, "cycle");
    await ensureDir(dir);
    await writeFile(join(dir, "a.md"), "");
    await ensureDir(join(dir, "sub"));
    // Create a symlink that points back to the parent. By default the walker
    // skips symlinked entries, but even with followSymlinks it must not spin.
    await symlink("..", join(dir, "sub", "cycle"));
    const foundDefault = [];
    for await (const fp of walkFiles(dir)) foundDefault.push(fp);
    assert.ok(foundDefault.length >= 1, "expected at least the real file");
    const foundFollow = [];
    for await (const fp of walkFiles(dir, { followSymlinks: true })) foundFollow.push(fp);
    // Real file visited at most a bounded number of times; just assert it completes.
    assert.ok(foundFollow.length >= 1);
  });

  it("excludes node_modules and .git by default", async () => {
    const dir = join(scratch, "ignore");
    await ensureDir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "pkg.js"), "");
    await ensureDir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: x");
    await writeFile(join(dir, "real.md"), "");
    const found = [];
    for await (const fp of walkFiles(dir)) found.push(fp);
    assert.ok(found.some((p) => p.endsWith("real.md")));
    assert.ok(!found.some((p) => p.includes("/node_modules/")));
    assert.ok(!found.some((p) => p.includes("/.git/")));
  });
});

describe("fsx.sha256", () => {
  it("produces a stable hex digest", () => {
    assert.equal(sha256("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("fsx.exists", () => {
  it("reports true for present paths, false for absent ones", async () => {
    const p = join(scratch, "here.txt");
    await writeFile(p, "x");
    assert.equal(await exists(p), true);
    assert.equal(await exists(join(scratch, "nowhere")), false);
  });
});

// Guard against a real regression: atomicWriteText must not leave tmp file on
// a failed write (e.g. writing to a path whose parent is a file).
describe("fsx.atomicWriteText cleanup on failure", () => {
  it("cleans up tmp file when rename fails", async () => {
    const dir = join(scratch, "conflict");
    await ensureDir(dir);
    // Create a directory where we want a file; writeFile will fail with EISDIR.
    const collision = join(dir, "blocked");
    await mkdir(collision);
    await assert.rejects(() => atomicWriteText(collision, "x"));
    const entries = await readdir(dir);
    assert.ok(entries.every((e) => !e.startsWith("blocked.tmp-")), "stale tmp file");
  });
});
