// lint/require-cache-block.mjs
// Enforces that every SKILL.md with more than 40 non-blank body lines
// (after frontmatter) contains <!-- cache-control:static --> and
// <!-- cache-control:dynamic --> markers in the body.
//
// Usage: node scripts/lint/require-cache-block.mjs
//   Exit 0 on pass, 1 on failure.

import { readFile, readdir } from "node:fs/promises";
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
  const skillDirs = await readdir(SKILLS_DIR, { withFileTypes: true });
  const results = [];

  for (const entry of skillDirs) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(SKILLS_DIR, entry.name, "SKILL.md");
    const relPath = relative(BUNDLE, skillMd);
    let content;
    try {
      content = await readFile(skillMd, "utf8");
    } catch {
      results.push({ path: relPath, status: "warn", reason: "SKILL.md missing or unreadable" });
      continue;
    }

    const parsed = matter(content);
    const body = parsed.content;
    const bodyLines = body.split("\n").filter((l) => l.trim().length > 0).length;

    if (bodyLines <= MIN_LINES_THRESHOLD) {
      results.push({ path: relPath, status: "exempt", reason: `${bodyLines} lines <= ${MIN_LINES_THRESHOLD}` });
      continue;
    }

    const hasStatic = body.includes(STATIC_MARKER);
    const hasDynamic = body.includes(DYNAMIC_MARKER);

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
    } else if (r.status === "warn") {
      process.stderr.write(`  WARN  ${r.path} (${r.reason})\n`);
    } else {
      process.stderr.write(`  FAIL  ${r.path} — missing: ${r.missing.join(", ")}\n`);
    }
  }
  process.exit(ok ? 0 : 1);
}
