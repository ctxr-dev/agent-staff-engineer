// lint/require-cache-block.mjs
// Enforces that every SKILL.md with > 500 tokens (rough: > 40 lines after
// frontmatter) contains a <!-- cache-control:static --> marker. Files below
// the threshold are exempt because caching overhead exceeds savings.
//
// Usage: node scripts/lint/require-cache-block.mjs [--fix]
//   --fix: not supported yet (marker placement requires judgment).
//   Exit 0 on pass, 1 on failure.

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const BUNDLE = join(fileURLToPath(import.meta.url), "..", "..", "..");
const SKILLS_DIR = join(BUNDLE, "skills");
const STATIC_MARKER = "<!-- cache-control:static -->";
const DYNAMIC_MARKER = "<!-- cache-control:dynamic -->";
const MIN_LINES_THRESHOLD = 40;

/**
 * Lint all SKILL.md files for cache-control markers.
 * Returns { ok, results } where results is an array of per-file outcomes.
 */
export async function lintCacheBlocks() {
  const { readdir } = await import("node:fs/promises");
  const skillDirs = await readdir(SKILLS_DIR, { withFileTypes: true });
  const results = [];

  for (const entry of skillDirs) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(SKILLS_DIR, entry.name, "SKILL.md");
    let content;
    try {
      content = await readFile(skillMd, "utf8");
    } catch {
      continue;
    }

    const parsed = matter(content);
    const bodyLines = parsed.content.split("\n").filter((l) => l.trim().length > 0).length;
    const relPath = relative(BUNDLE, skillMd);

    if (bodyLines < MIN_LINES_THRESHOLD) {
      results.push({ path: relPath, status: "exempt", reason: `${bodyLines} lines < ${MIN_LINES_THRESHOLD}` });
      continue;
    }

    const hasStatic = content.includes(STATIC_MARKER);
    const hasDynamic = content.includes(DYNAMIC_MARKER);

    if (hasStatic && hasDynamic) {
      results.push({ path: relPath, status: "pass" });
    } else {
      const missing = [];
      if (!hasStatic) missing.push(STATIC_MARKER);
      if (!hasDynamic) missing.push(DYNAMIC_MARKER);
      results.push({ path: relPath, status: "fail", missing });
    }
  }

  return { ok: results.every((r) => r.status !== "fail"), results };
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ok, results } = await lintCacheBlocks();
  for (const r of results) {
    if (r.status === "pass") {
      process.stdout.write(`  PASS  ${r.path}\n`);
    } else if (r.status === "exempt") {
      process.stdout.write(`  SKIP  ${r.path} (${r.reason})\n`);
    } else {
      process.stderr.write(`  FAIL  ${r.path} — missing: ${r.missing.join(", ")}\n`);
    }
  }
  process.exit(ok ? 0 : 1);
}
