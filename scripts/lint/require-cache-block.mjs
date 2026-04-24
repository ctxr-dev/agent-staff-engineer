// lint/require-cache-block.mjs
// Enforces that every SKILL.md with more than 40 non-blank body lines
// (after frontmatter) contains exactly one <!-- cache-control:static -->
// marker followed by exactly one <!-- cache-control:dynamic --> marker.
//
// Usage: node scripts/lint/require-cache-block.mjs
//   Exit 0 on pass, 1 on failure.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "..");
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
      results.push({ path: relPath, status: "fail", problems: ["SKILL.md file itself (missing or unreadable)"] });
      continue;
    }

    const parsed = matter(content);
    const body = parsed.content;
    const bodyLines = body.split("\n").filter((l) => l.trim().length > 0).length;

    if (bodyLines <= MIN_LINES_THRESHOLD) {
      results.push({ path: relPath, status: "exempt", reason: `${bodyLines} lines <= ${MIN_LINES_THRESHOLD}` });
      continue;
    }

    const escStatic = STATIC_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escDynamic = DYNAMIC_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const staticCount = (body.match(new RegExp(escStatic, "g")) || []).length;
    const dynamicCount = (body.match(new RegExp(escDynamic, "g")) || []).length;

    const problems = [];
    if (staticCount === 0) problems.push(`missing ${STATIC_MARKER}`);
    if (dynamicCount === 0) problems.push(`missing ${DYNAMIC_MARKER}`);
    if (staticCount > 1) problems.push(`${STATIC_MARKER} appears ${staticCount} times (expected 1)`);
    if (dynamicCount > 1) problems.push(`${DYNAMIC_MARKER} appears ${dynamicCount} times (expected 1)`);

    if (staticCount === 1 && dynamicCount === 1) {
      const staticIdx = body.indexOf(STATIC_MARKER);
      const dynamicIdx = body.indexOf(DYNAMIC_MARKER);
      if (staticIdx > dynamicIdx) {
        problems.push("static marker must appear before dynamic marker");
      }
    }

    if (problems.length === 0) {
      results.push({ path: relPath, status: "pass" });
    } else {
      results.push({ path: relPath, status: "fail", problems });
    }
  }

  return { ok: results.every((r) => r.status !== "fail"), results };
}

// CLI entry point
const thisFile = resolve(fileURLToPath(import.meta.url));
const invoked = resolve(process.argv[1] ?? "");
if (thisFile === invoked) {
  const { ok, results } = await lintCacheBlocks();
  for (const r of results) {
    if (r.status === "pass") {
      process.stdout.write(`  PASS  ${r.path}\n`);
    } else if (r.status === "exempt") {
      process.stdout.write(`  SKIP  ${r.path} (${r.reason})\n`);
    } else {
      process.stderr.write(`  FAIL  ${r.path} — ${r.problems.join("; ")}\n`);
    }
  }
  process.exit(ok ? 0 : 1);
}
