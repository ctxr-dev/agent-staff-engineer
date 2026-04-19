#!/usr/bin/env node
// validate_bundle.mjs
// Portability gate for the agent bundle. Run from the bundle root.
// Exits 0 when clean, 1 on any violation.
//
// Checks performed:
//   1. No project-specific literals (cafeiner, caffeinic, meshin-dev, healthkit,
//      Caffeinic.xcodeproj) across skills/, rules/, memory-seeds/, templates/,
//      schemas/, examples/, scripts/. .git/ is excluded.
//   2. No em or en dashes in authored markdown (excluding fenced code blocks).
//      Fenced code blocks are where we show the rule's own bad examples.
//   3. Every SKILL.md under skills/ has a "## Project contract" section.
//   4. examples/ops.config.example.json validates against the schema.
//   5. Every scripts/*.mjs imports only from node: builtins or relative paths.
//   6. No package.json inside scripts/.
//   7. Every template under templates/ has a header comment listing the
//      ops.config.json keys it reads.
//   8. Every rule under rules/ has frontmatter declaring portable: true.
//   9. Every memory seed under memory-seeds/ has frontmatter and a `tags` key.
//  10. No committed markdown embeds a raw absolute home path like
//      "/Users/<name>/" or "/home/<name>/". Docs must use "~/..." or
//      project-relative paths so teammates on different machines do not
//      trip over a hard-coded username.
//  11. Every skill whose SKILL.md references a doc target under
//      .development/{shared,local,cache}/ must also reference
//      rules/llm-wiki.md, so the write-through-wiki contract from
//      AGENT.md is enforced at the skill level.
//  12. bundle-index.md is complete and link-valid:
//      - every markdown link inside bundle-index.md points at a
//        file that exists on disk (dead-link failures include the
//        OS error code when it is not a plain "file not found");
//      - every required surface directory (skills/, rules/,
//        templates/, memory-seeds/) exists as a directory, not
//        just "empty or missing" (missing-surface);
//      - every file under skills/*/SKILL.md, rules/*.md,
//        templates/*.md, memory-seeds/*.md appears at least once
//        in bundle-index.md (no orphans);
//      - when a new bundle doc is added, bundle-index must learn
//        about it in the same PR.
//  13. Every SKILL.md / rule / memory-seed frontmatter parses as
//      real YAML (via gray-matter) AND, for SKILL.md, the
//      `trigger_on` / `do_not_trigger_on` keys are arrays of
//      plain strings. The previous regex-only checks missed a
//      whole class of bug where an unquoted `: ` inside a bullet
//      silently turned the list entry into a {key: value} mapping,
//      which downstream consumers (Claude Code runtime) parse as
//      garbage. Failure classes: `frontmatter-parse:` (hard YAML
//      error), `frontmatter-type:` (list entry is not a string).
//  14. No stale references to the pre-trackers names:
//      - `github-sync` (renamed to `tracker-sync`)
//      - `github-source-of-truth` (renamed to `tracker-source-of-truth`)
//      Catches a future PR that re-introduces the old name in a
//      skill, rule, doc, or template before it lands. The canonical
//      tracker lib's historical comments under scripts/lib/trackers/
//      are exempt: they explain the rename for future readers.
//

import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { preflight } from "./preflight.mjs";
import { walkFiles, readTextOrNull } from "./lib/fsx.mjs";
import { validate } from "./lib/schema.mjs";
import { extractIndexLinks, REQUIRED_INDEX_SURFACES } from "./lib/bundleIndex.mjs";

await preflight();

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = [
  "skills",
  "rules",
  "memory-seeds",
  "templates",
  "schemas",
  "examples",
  "scripts",
];
const SCAN_TOP_LEVEL_MD = ["README.md", "INSTALL.md", "CONTRIBUTING.md", "AGENT.md"];
// The validator holds the literal list for matching; scanning its own source
// would always find them. Skip this file (and its own directory helpers when
// they reference the list in a regex).
const SELF_EXCLUDE = new Set([
  "scripts/validate_bundle.mjs",
]);
// Each literal split across bytes so the validator's own source does not
// contain the literal form. Reassembled at start-up.
const FORBIDDEN_LITERALS = [
  ["caf", "einer"].join(""),
  ["caff", "einic"].join(""),
  ["mesh", "in", "-dev"].join(""),
  ["health", "kit"].join(""),
  ["Caff", "einic", ".xcodeproj"].join(""),
];

const errors = [];
const warnings = [];

function err(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

/** Strip fenced code blocks from markdown content to exclude them from scans. */
function stripFencedBlocks(text) {
  const lines = text.split("\n");
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(""); // preserve line numbers
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out.join("\n");
}

// ---- 1. Forbidden literals ----------------------------------------------
async function checkLiterals() {
  for (const d of SCAN_DIRS) {
    const abs = join(BUNDLE_ROOT, d);
    try {
      for await (const fp of walkFiles(abs, { ignoreDirs: new Set([".git", "node_modules"]) })) {
        if (!/\.(md|json|mjs)$/.test(fp)) continue;
        const rel = relative(BUNDLE_ROOT, fp);
        if (SELF_EXCLUDE.has(rel)) continue;
        const content = await readFile(fp, "utf8");
        for (const term of FORBIDDEN_LITERALS) {
          const re = new RegExp(term, "gi");
          let m;
          while ((m = re.exec(content)) !== null) {
            const before = content.slice(0, m.index);
            const line = before.split("\n").length;
            err(`forbidden literal '${term}' in ${rel}:${line}`);
          }
        }
      }
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
  }
}

// ---- 2. Dash-free markdown ----------------------------------------------
async function checkDashes() {
  const folders = ["skills", "rules", "memory-seeds", "templates"];
  const extraFiles = SCAN_TOP_LEVEL_MD.map((f) => join(BUNDLE_ROOT, f));
  const mdTargets = [];
  for (const d of folders) {
    const abs = join(BUNDLE_ROOT, d);
    try {
      for await (const fp of walkFiles(abs)) {
        if (fp.endsWith(".md")) mdTargets.push(fp);
      }
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
  }
  for (const fp of extraFiles) {
    try {
      const text = await readFile(fp, "utf8");
      if (text) mdTargets.push(fp);
    } catch {
      /* file may not exist; other checks will flag that */
    }
  }
  for (const fp of mdTargets) {
    const raw = await readFile(fp, "utf8");
    const stripped = stripFencedBlocks(raw);
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("\u2014") || lines[i].includes("\u2013")) {
        err(`em/en dash in ${relative(BUNDLE_ROOT, fp)}:${i + 1}`);
      }
    }
  }
}

// ---- 3. SKILL.md structure ----------------------------------------------
async function checkSkillStructure() {
  const skillsDir = join(BUNDLE_ROOT, "skills");
  for await (const fp of walkFiles(skillsDir)) {
    if (!fp.endsWith("SKILL.md")) continue;
    const text = await readFile(fp, "utf8");
    if (!/^## Project contract\s*$/m.test(text)) {
      err(`missing '## Project contract' section in ${relative(BUNDLE_ROOT, fp)}`);
    }
    if (!/^name:\s+/m.test(text)) {
      err(`missing 'name:' in frontmatter of ${relative(BUNDLE_ROOT, fp)}`);
    }
  }
}

// ---- 4. Example config validates against the schema --------------------
async function checkExampleAgainstSchema() {
  const schemaPath = join(BUNDLE_ROOT, "schemas", "ops.config.schema.json");
  const examplePath = join(BUNDLE_ROOT, "examples", "ops.config.example.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const example = JSON.parse(await readFile(examplePath, "utf8"));
  const { ok, errors: es } = validate(schema, example);
  if (!ok) {
    for (const e of es) err(`schema: ${e.path}: ${e.message}`);
  }
}

// ---- 5 + 6. Zero-deps enforcement ---------------------------------------
async function checkZeroDeps() {
  // The bundle ships with a small set of declared runtime dependencies (ajv,
  // ajv-formats, diff, gray-matter, semver). Bare imports that resolve to
  // one of those names are allowed; anything else is flagged.
  const pkgPath = join(BUNDLE_ROOT, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const declaredDeps = new Set(Object.keys(pkg.dependencies ?? {}));

  const scriptsDir = join(BUNDLE_ROOT, "scripts");
  for await (const fp of walkFiles(scriptsDir)) {
    const rel = relative(BUNDLE_ROOT, fp);
    if (fp.endsWith("package.json")) err(`package.json must not exist in scripts/: ${rel}`);
    if (!fp.endsWith(".mjs")) continue;
    if (SELF_EXCLUDE.has(rel)) continue; // the validator names its own regex literals
    const text = await readFile(fp, "utf8");
    const specs = [];
    const importRegex = /import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/g;
    let m;
    while ((m = importRegex.exec(text)) !== null) specs.push(m[1]);
    const dynImportRegex = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynImportRegex.exec(text)) !== null) specs.push(m[1]);
    for (const spec of specs) {
      const okBuiltinOrRelative =
        spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
      // Treat a bare specifier as acceptable when it (or its package-name prefix) is declared in package.json.
      const specBase = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      const okDeclared = declaredDeps.has(specBase);
      if (!okBuiltinOrRelative && !okDeclared) {
        err(`bare import '${spec}' in ${rel} (not declared in package.json dependencies)`);
      }
    }
  }
}

// ---- 7. Template header comments ----------------------------------------
async function checkTemplateHeaders() {
  const templatesDir = join(BUNDLE_ROOT, "templates");
  for await (const fp of walkFiles(templatesDir)) {
    if (!fp.endsWith(".md")) continue;
    const text = await readFile(fp, "utf8");
    if (!/<!--[\s\S]*?ops\.config keys read:[\s\S]*?-->/.test(text)) {
      warn(`template lacks 'ops.config keys read' header comment: ${relative(BUNDLE_ROOT, fp)}`);
    }
  }
}

// ---- 8. Rule frontmatter ------------------------------------------------
async function checkRuleFrontmatter() {
  const rulesDir = join(BUNDLE_ROOT, "rules");
  for await (const fp of walkFiles(rulesDir)) {
    if (!fp.endsWith(".md")) continue;
    const text = await readTextOrNull(fp);
    if (text == null) continue;
    if (!/^portable:\s*true\s*$/m.test(text)) {
      err(`rule lacks 'portable: true' in frontmatter: ${relative(BUNDLE_ROOT, fp)}`);
    }
  }
}

// ---- 9. Memory seed frontmatter -----------------------------------------
async function checkSeedFrontmatter() {
  const seedsDir = join(BUNDLE_ROOT, "memory-seeds");
  for await (const fp of walkFiles(seedsDir)) {
    if (!fp.endsWith(".md")) continue;
    const text = await readFile(fp, "utf8");
    if (!/^---\n/.test(text)) err(`seed lacks frontmatter: ${relative(BUNDLE_ROOT, fp)}`);
    if (!/^type:\s*/m.test(text)) err(`seed lacks 'type:' in frontmatter: ${relative(BUNDLE_ROOT, fp)}`);
    if (!/^portable:\s*true\s*$/m.test(text)) err(`seed lacks 'portable: true': ${relative(BUNDLE_ROOT, fp)}`);
    if (!/^tags:/m.test(text)) err(`seed lacks 'tags:' key: ${relative(BUNDLE_ROOT, fp)}`);
  }
}

// ---- 10. No raw absolute home paths in committed markdown -------------
async function checkNoRawHomePaths() {
  const folders = ["skills", "rules", "memory-seeds", "templates", "design"];
  const extraFiles = SCAN_TOP_LEVEL_MD.map((f) => join(BUNDLE_ROOT, f));
  const mdTargets = [];
  for (const d of folders) {
    const abs = join(BUNDLE_ROOT, d);
    try {
      for await (const fp of walkFiles(abs)) {
        if (fp.endsWith(".md")) mdTargets.push(fp);
      }
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
  }
  for (const fp of extraFiles) {
    try {
      const text = await readFile(fp, "utf8");
      if (text) mdTargets.push(fp);
    } catch {
      /* file may not exist; other checks will flag that */
    }
  }
  // /Users/<name>/ or /home/<name>/ with an explicit username segment.
  // Placeholders like /Users/<you>/ stay clear (< is not in the class).
  const homePathRe = /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//g;
  for (const fp of mdTargets) {
    const raw = await readFile(fp, "utf8");
    let m;
    while ((m = homePathRe.exec(raw)) !== null) {
      const line = raw.slice(0, m.index).split("\n").length;
      err(
        `raw absolute home path '${m[0]}' in ${relative(BUNDLE_ROOT, fp)}:${line} (use '~/...' or a '<you>' placeholder)`,
      );
    }
  }
}

// ---- 11. Skills that write under .development/** must cite llm-wiki rule
// Uses the SKILL.md frontmatter's `writes_to_filesystem:` line as the
// source of truth for whether the skill persists docs. A mention of
// `paths.reports`, `paths.runbooks`, or a literal `.development/...`
// path in that line triggers the rule-reference requirement. Body
// mentions of the same keys for configuration-only purposes (e.g.,
// adapt-system listing them as keys it reads) do not trip the check.
async function checkWikiRuleReferences() {
  const skillsDir = join(BUNDLE_ROOT, "skills");
  const wikiScopeInWriteDeclRe =
    /^writes_to_filesystem:.*(?:paths\.reports|paths\.runbooks|\.development\/(?:shared|local|cache))/m;
  try {
    for await (const fp of walkFiles(skillsDir)) {
      if (!fp.endsWith("SKILL.md")) continue;
      const text = await readFile(fp, "utf8");
      // Look inside the first frontmatter block only.
      const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      if (!wikiScopeInWriteDeclRe.test(fmMatch[1])) continue;
      if (!/rules\/llm-wiki\.md/.test(text)) {
        err(
          `skill writes under .development/** (per writes_to_filesystem) but does not reference rules/llm-wiki.md: ${relative(BUNDLE_ROOT, fp)}`,
        );
      }
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") throw e;
  }
}

// ---- 12. bundle-index.md completeness + link integrity ----------------
// The agent reads bundle-index.md first to route a task to the minimal
// doc slice. That's only useful if the index is complete (every skill /
// rule / template / memory seed is routable from it) and link-valid
// (every path it names exists). Orphans silently reduce token economy;
// dead links silently mislead the agent.
//
// Link-extraction logic is shared with tests/bundle-index.test.mjs via
// scripts/lib/bundleIndex.mjs so prod and test can't drift.
//
// Failure messages use class prefixes (`missing-index:`, `dead-link:`,
// `orphan:`) so a contributor scanning a validate run can tell cause
// from effect at a glance (e.g. a renamed file produces one `dead-link`
// plus one `orphan` unless both sides are updated).
async function checkBundleIndex() {
  const indexPath = join(BUNDLE_ROOT, "bundle-index.md");
  let indexText;
  try {
    indexText = await readFile(indexPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      err("missing-index: bundle-index.md is missing at the bundle root");
      return;
    }
    // Surface EACCES / EISDIR / etc. with their real class instead of
    // masking them as "missing" — a permission or IO fault is a bug the
    // contributor needs to see clearly, not a false "just add the file".
    throw e;
  }
  const referenced = extractIndexLinks(indexText);
  for (const rel of referenced) {
    const abs = resolve(BUNDLE_ROOT, rel);
    try {
      // Existence probe only; no need to read the bytes. Using stat()
      // over readFile() lets us distinguish ENOENT from EACCES/EISDIR
      // and include the OS error code in the message so a contributor
      // can act on it without guessing. We also assert the target is
      // a regular file: a link to `templates/` (no trailing filename)
      // exists but does not satisfy the bundle-index contract of
      // "points at a file".
      const s = await stat(abs);
      if (!s.isFile()) {
        const type = s.isDirectory() ? "directory" : "not a regular file";
        err(`dead-link: bundle-index.md -> ${rel} (${type})`);
      }
    } catch (e) {
      const code = e && e.code ? e.code : "unknown";
      if (code === "ENOENT") {
        err(`dead-link: bundle-index.md -> ${rel} (file not found)`);
      } else {
        err(`dead-link: bundle-index.md -> ${rel} (${code})`);
      }
    }
  }
  for (const { dir, nameFilter } of REQUIRED_INDEX_SURFACES) {
    const abs = join(BUNDLE_ROOT, dir);
    // Surface-dir precondition: the directory MUST exist and be a
    // directory. walkFiles() swallows ENOENT silently (yields nothing),
    // which would let a missing required surface slip through as "no
    // orphans found" — exactly the structural regression the tests
    // already treat as fatal. Mirror the test's stat() check here so
    // validate + test agree on what counts as a broken bundle.
    try {
      const s = await stat(abs);
      if (!s.isDirectory()) {
        err(`missing-surface: required bundle surface ${dir}/ is not a directory`);
        continue;
      }
    } catch (e) {
      if (e && e.code === "ENOENT") {
        err(`missing-surface: required bundle surface ${dir}/ does not exist`);
        continue;
      }
      throw e;
    }
    for await (const fp of walkFiles(abs)) {
      const rel = relative(BUNDLE_ROOT, fp).split(/[\\/]+/).join("/");
      if (!nameFilter(rel)) continue;
      if (!referenced.has(rel)) {
        err(`orphan: ${rel} is not linked from bundle-index.md`);
      }
    }
  }
}

// ---- 13. Frontmatter parses as YAML + lists are string-arrays ----------
// The earlier checks are regex-based and miss a whole class of bug: an
// unquoted `: ` inside a list bullet (e.g. "Follow foo: bar") parses as
// a YAML mapping `{Follow foo: bar}` rather than a plain string, and
// some descriptions with stray colons make the whole frontmatter
// unparseable. Both classes pass the regex gates but bite downstream
// consumers (Claude Code runtime, which parses this as real YAML).
// This check runs real gray-matter over every SKILL.md, rule, and seed.
async function checkFrontmatterParses() {
  const targets = [];
  for await (const fp of walkFiles(join(BUNDLE_ROOT, "skills"))) {
    if (fp.endsWith("/SKILL.md")) targets.push({ fp, kind: "skill" });
  }
  for await (const fp of walkFiles(join(BUNDLE_ROOT, "rules"))) {
    if (fp.endsWith(".md")) targets.push({ fp, kind: "rule" });
  }
  for await (const fp of walkFiles(join(BUNDLE_ROOT, "memory-seeds"))) {
    if (fp.endsWith(".md")) targets.push({ fp, kind: "seed" });
  }
  for (const { fp, kind } of targets) {
    const rel = relative(BUNDLE_ROOT, fp);
    const text = await readTextOrNull(fp);
    if (text == null) continue;
    let data;
    try {
      data = matter(text).data;
    } catch (e) {
      const msg = String(e && e.reason ? e.reason : (e && e.message ? e.message : e))
        .split("\n")[0];
      err(`frontmatter-parse: ${rel} (${msg})`);
      continue;
    }
    // For SKILL.md, trigger_on / do_not_trigger_on are list fields that
    // downstream tooling expects to be string[]. A mapping in there is
    // the silent-mis-parse bug the round-4 threads flagged.
    if (kind === "skill") {
      for (const key of ["trigger_on", "do_not_trigger_on"]) {
        const val = data[key];
        if (val === undefined) continue;
        if (!Array.isArray(val)) {
          err(`frontmatter-type: ${rel}:${key} must be a list, got ${typeof val}`);
          continue;
        }
        val.forEach((entry, i) => {
          if (typeof entry !== "string") {
            err(`frontmatter-type: ${rel}:${key}[${i}] must be a string (got ${typeof entry}; likely an unquoted ': ' turned the bullet into a mapping)`);
          }
        });
      }
    }
  }
}

// ---- 14. No stale legacy tracker names -------------------------------
// After the github-sync -> tracker-sync + github-source-of-truth ->
// tracker-source-of-truth rename, no bundle-shipped skill / rule /
// template / doc should reference the retired names. The rename is a
// hard break; a drive-by PR that introduces the old name in a new doc
// would silently point readers at paths that don't exist. This gate
// catches it.
//
// scripts/lib/trackers/ is deliberately exempt: those files keep
// historical "formerly github-sync" comments so readers discover the
// old name on code-spelunking. The comments live in a single subtree,
// so a path-prefix exemption is precise enough.
async function checkNoLegacyNames() {
  const legacyNeedles = [
    // Retired skill name. Use word-boundary to avoid matching things
    // like "async" or random substrings. The pattern matches both the
    // bare `github-sync` and the scripts/lib/ path `lib/github-sync`.
    { needle: "github-sync", class: "legacy-skill-name" },
    { needle: "github-source-of-truth", class: "legacy-rule-name" },
  ];
  const scanRoots = [
    "skills",
    "rules",
    "memory-seeds",
    "templates",
    "design",
    "examples",
    "schemas",
  ];
  const topLevelDocs = [
    "AGENT.md",
    "README.md",
    "INSTALL.md",
    "CONTRIBUTING.md",
    "bundle-index.md",
  ];
  const exemptPrefixes = [
    "scripts/lib/trackers/",
  ];

  const fpsToScan = [];
  for (const root of scanRoots) {
    for await (const fp of walkFiles(join(BUNDLE_ROOT, root))) {
      if (fp.endsWith(".md") || fp.endsWith(".json") || fp.endsWith(".mjs")) {
        fpsToScan.push(fp);
      }
    }
  }
  for (const top of topLevelDocs) {
    const fp = join(BUNDLE_ROOT, top);
    try {
      await stat(fp);
      fpsToScan.push(fp);
    } catch {
      // file absent is fine; the list is an allow-list of known docs.
    }
  }

  for (const fp of fpsToScan) {
    const rel = relative(BUNDLE_ROOT, fp).split(/[\\/]+/).join("/");
    if (exemptPrefixes.some((p) => rel.startsWith(p))) continue;
    const text = await readTextOrNull(fp);
    if (text == null) continue;
    for (const { needle, class: cls } of legacyNeedles) {
      if (text.includes(needle)) {
        err(`${cls}: ${rel} still references '${needle}' (renamed; update to the tracker-* form)`);
      }
    }
  }
}

await checkLiterals();
await checkDashes();
await checkSkillStructure();
await checkExampleAgainstSchema();
await checkZeroDeps();
await checkTemplateHeaders();
await checkRuleFrontmatter();
await checkSeedFrontmatter();
await checkNoRawHomePaths();
await checkWikiRuleReferences();
await checkBundleIndex();
await checkFrontmatterParses();
await checkNoLegacyNames();

const summary = `validate_bundle: ${errors.length} error(s), ${warnings.length} warning(s)`;
if (errors.length === 0 && warnings.length === 0) {
  // eslint-disable-next-line no-console
  console.log("validate_bundle: PASS");
  process.exit(0);
}
for (const w of warnings) process.stdout.write(`warn: ${w}\n`);
for (const e of errors) process.stderr.write(`ERROR: ${e}\n`);
process.stderr.write(`${summary}\n`);
process.exit(errors.length === 0 ? 0 : 1);
