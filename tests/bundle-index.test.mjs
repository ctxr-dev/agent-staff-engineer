// bundle-index.test.mjs
// Asserts the invariants validate_bundle.mjs check #12 enforces at the
// bundle level. Imports the link-extraction helper DIRECTLY from the
// same module the validator uses (`scripts/lib/bundleIndex.mjs`) so the
// two cannot drift: a future tweak to the regex updates prod + test
// together.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkFiles } from "../scripts/lib/fsx.mjs";
import {
  extractIndexLinks,
  REQUIRED_INDEX_SURFACES,
} from "../scripts/lib/bundleIndex.mjs";

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadIndexLinks() {
  const text = await readFile(join(BUNDLE_ROOT, "bundle-index.md"), "utf8");
  return extractIndexLinks(text);
}

// Walks `dir` (required to exist) and returns bundle-relative paths
// filtered by `nameFilter`. Throws an explicit error when `dir` is
// missing: the caller is asking about a surface the bundle-index MUST
// cover, so a missing dir is a structural regression. `walkFiles()`
// itself swallows ENOENT (yields nothing), so we stat() up front to
// surface a clear message rather than let it fall through to a
// confusing "expected at least one doc" assertion failure downstream.
async function collectRequiredDocs(dir, nameFilter) {
  const abs = join(BUNDLE_ROOT, dir);
  try {
    const s = await stat(abs);
    if (!s.isDirectory()) {
      throw new Error(`collectRequiredDocs: ${dir} is not a directory`);
    }
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new Error(
        `collectRequiredDocs: required bundle surface ${dir}/ does not exist`,
      );
    }
    throw e;
  }
  const rels = [];
  for await (const fp of walkFiles(abs)) {
    const rel = relative(BUNDLE_ROOT, fp).split(/[\\/]+/).join("/");
    if (!nameFilter(rel)) continue;
    rels.push(rel);
  }
  return rels;
}

describe("extractIndexLinks: regex behaviour (pinned fixtures)", () => {
  it("accepts a plain relative link", () => {
    const out = extractIndexLinks("[x](rel/path.md)");
    assert.ok(out.has("rel/path.md"));
  });
  it("strips #anchor suffixes", () => {
    const out = extractIndexLinks("[x](path.md#section)");
    assert.ok(out.has("path.md"));
    assert.ok(!out.has("path.md#section"));
  });
  it("rejects image references `![alt](path)`", () => {
    const out = extractIndexLinks("![img](assets/icon.png)");
    assert.equal(out.size, 0, "image references must not be treated as routing links");
  });
  it("rejects external URLs and mailto", () => {
    const out = extractIndexLinks("[a](https://example.com) [b](http://x) [c](mailto:a@b)");
    assert.equal(out.size, 0);
  });
  it("rejects fragment-only anchors", () => {
    const out = extractIndexLinks("[x](#only-anchor)");
    assert.equal(out.size, 0);
  });
  it("rejects POSIX-absolute paths (would escape bundle root)", () => {
    const out = extractIndexLinks("[x](/etc/passwd) [y](/absolute/in/repo.md)");
    assert.equal(out.size, 0, "leading '/' must not produce a reference; avoids host-dependent reads in CI");
  });
  it("rejects Windows drive-letter paths", () => {
    const out = extractIndexLinks("[x](C:\\Windows\\win.ini) [y](D:/foo/bar.md)");
    assert.equal(out.size, 0, "drive-letter prefixes must not produce references");
  });
  it("rejects parent-traversal regardless of separator style", () => {
    // Includes POSIX '/', Windows '\\', and mixed forms. On the
    // target's eventual filesystem (CI is Linux), backslashes may not
    // literally escape the root, but normalising here makes the
    // invariant hold cross-platform and defends against copy-pasted
    // Windows paths in a contributor's editor.
    const cases = [
      "[x](../outside.md)",
      "[y](a/../../escape.md)",
      "[z](a/..)",
      "[w](..\\outside.md)",
      "[v](a\\..\\..\\escape.md)",
      "[u](a\\..)",
      "[s](sub/..\\outside.md)",
    ];
    for (const text of cases) {
      const out = extractIndexLinks(text);
      assert.equal(
        out.size,
        0,
        `parent traversal in ${text} must not produce a reference`,
      );
    }
  });
  it("canonicalises leading './' (so './foo' and 'foo' are interchangeable)", () => {
    const out = extractIndexLinks("[x](./same-dir.md) [y](sub/dir/file.md) [z](././still-here.md)");
    assert.ok(out.has("same-dir.md"), "leading './' must be stripped");
    assert.ok(!out.has("./same-dir.md"), "non-canonical form must NOT be present");
    assert.ok(out.has("sub/dir/file.md"));
    assert.ok(out.has("still-here.md"), "repeated './' prefixes all stripped");
  });
  it("unifies backslash separators to forward slashes (canonical POSIX form)", () => {
    const out = extractIndexLinks("[x](sub\\dir\\file.md)");
    assert.ok(out.has("sub/dir/file.md"), "backslashes must canonicalise to POSIX form for Set lookup");
    assert.ok(!out.has("sub\\dir\\file.md"), "non-canonical form must NOT be present");
  });
  it("extracts multiple links from mixed prose", () => {
    const text = "See [a](one.md) and [b](two.md#x); not [this](https://y) and not ![img](p.png).";
    const out = extractIndexLinks(text);
    assert.deepEqual([...out].sort(), ["one.md", "two.md"]);
  });
});

describe("bundle-index.md: link integrity", () => {
  it("every internal link points at a file that exists on disk", async () => {
    const refs = await loadIndexLinks();
    for (const rel of refs) {
      const abs = resolve(BUNDLE_ROOT, rel);
      await assert.doesNotReject(
        readFile(abs, "utf8"),
        `bundle-index.md references missing file: ${rel}`,
      );
    }
  });
});

describe("bundle-index.md: orphan detection", () => {
  // Iterate the SAME surfaces the validator walks, so a future
  // REQUIRED_INDEX_SURFACES extension automatically gets covered.
  for (const { dir, nameFilter } of REQUIRED_INDEX_SURFACES) {
    it(`every required doc under ${dir}/ appears in the index`, async () => {
      const refs = await loadIndexLinks();
      const docs = await collectRequiredDocs(dir, nameFilter);
      assert.ok(docs.length > 0, `expected at least one required doc under ${dir}/`);
      for (const rel of docs) {
        assert.ok(
          refs.has(rel),
          `bundle-index.md must reference ${rel} (add a routing entry)`,
        );
      }
    });
  }
});

describe("bundle-index.md: editorial pins (lock specific routing decisions)", () => {
  it("routes to the pr-iteration runbook from the 'iterate on review comments' intent", async () => {
    const refs = await loadIndexLinks();
    assert.ok(
      refs.has("skills/pr-iteration/runbook.md"),
      "runbook is the deep-dive for iteration; index must route to it",
    );
  });
});
