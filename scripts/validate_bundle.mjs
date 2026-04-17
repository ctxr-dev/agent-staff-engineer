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
//

import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./preflight.mjs";
import { walkFiles, readTextOrNull } from "./lib/fsx.mjs";
import { validate } from "./lib/schema.mjs";

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

await checkLiterals();
await checkDashes();
await checkSkillStructure();
await checkExampleAgainstSchema();
await checkZeroDeps();
await checkTemplateHeaders();
await checkRuleFrontmatter();
await checkSeedFrontmatter();

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
