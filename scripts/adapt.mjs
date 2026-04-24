#!/usr/bin/env node
// adapt.mjs
// Entry point for the adapt-system skill. Given free-form user intent and the
// current target project state, produces a cascading diff across
// ops.config.json, labels, templates, rules, and memory seeds.
//
// This file is the mechanical scaffold: it parses intent, loads current state,
// classifies signals, and emits a proposal. The proposal is a structured JSON
// object plus a human-readable diff. The actual "decide what to change" logic
// for edge cases is performed by Claude at invocation time, reading this
// script's proposal as context; this script never writes files on its own
// without --apply, and never mutates GitHub (that goes through tracker-sync).
//
// Usage:
//   node adapt.mjs --target <path> --intent "<user intent>" [--dry-run | --apply]
//

import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preflight } from "./preflight.mjs";
import { parseArgv, boolFlag, requireStringFlag } from "./lib/argv.mjs";
import { atomicWriteJson, readJsonOrNull } from "./lib/fsx.mjs";
import { validate } from "./lib/schema.mjs";
import { diffLines } from "./lib/diff.mjs";
import { CODE_REVIEW_SKILL, CODE_REVIEW_INTERNAL, CODE_REVIEW_NONE, CODE_REVIEW_PROVIDERS } from "./lib/constants.mjs";

// Guard: when tests import this module to exercise classify/applySignalToConfig,
// the CLI body must not run.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await main();
}

async function main() {
  await preflight();

  const { flags } = parseArgv(process.argv.slice(2), {
    booleans: new Set(["dry-run", "apply", "yes", "help"]),
  });
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const TARGET = resolve(flags.target ?? ".");
  const INTENT = requireStringFlag(flags, "intent");
  const APPLY = boolFlag(flags, "apply", false);
  const DRY_RUN = !APPLY;

  const configPath = join(TARGET, ".claude/ops.config.json");
  const schemaPath = join(BUNDLE_ROOT, "schemas/ops.config.schema.json");

  const current = await readJsonOrNull(configPath);
  if (!current) {
    process.stderr.write(
      `adapt: no ops.config.json at ${configPath}. Run bootstrap first.\n`
    );
    process.exit(1);
  }
  const schema = await readJsonOrNull(schemaPath);
  if (!schema) {
    process.stderr.write(`adapt: schema missing at ${schemaPath}\n`);
    process.exit(1);
  }

  const signals = classify(INTENT);
  process.stdout.write(`intent: ${INTENT}\n`);
  process.stdout.write(`signals:\n`);
  for (const s of signals) process.stdout.write(`  - ${s.kind}: ${s.value}\n`);
  if (signals.length === 0) {
    process.stdout.write(
      `no signals recognised. adapt-system usually asks a clarifying question at this point; here we exit with a note.\n`
    );
    process.exit(0);
  }

  const proposed = JSON.parse(JSON.stringify(current));
  const changeLog = [];

  for (const s of signals) {
    applySignalToConfig(proposed, s, changeLog);
  }

  const v = validate(schema, proposed);
  if (!v.ok) {
    process.stderr.write(`proposed config FAILS schema validation:\n`);
    for (const e of v.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.stderr.write(`not applying.\n`);
    process.exit(1);
  }

  const diff = diffLines(
    JSON.stringify(current, null, 2),
    JSON.stringify(proposed, null, 2),
    { labelA: "ops.config.json (current)", labelB: "ops.config.json (proposed)" }
  );

  process.stdout.write("\nproposed changes:\n");
  for (const line of changeLog) process.stdout.write(`  - ${line}\n`);

  if (diff.trim()) {
    process.stdout.write("\n--- ops.config.json diff ---\n");
    process.stdout.write(diff);
  } else {
    process.stdout.write("\nno ops.config.json changes needed (idempotent re-run).\n");
  }

  const plan = buildNonConfigPlan(signals, current, proposed);
  if (plan.length) {
    process.stdout.write("\nnon-config follow-ups (execute via Claude session):\n");
    for (const step of plan) process.stdout.write(`  - ${step}\n`);
  }

  if (DRY_RUN) {
    process.stdout.write("\n(dry-run) no files written. Re-run with --apply to update ops.config.json.\n");
    process.exit(0);
  }

  await atomicWriteJson(configPath, proposed);
  process.stdout.write(`\nwrote updated ${configPath}\n`);
}

// ---- Helpers ------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      "adapt.mjs  cascading diff for a shape-changing intent",
      "",
      "Options:",
      "  --target <path>   target project root (default: cwd)",
      "  --intent <text>   the user's free-form intent (required)",
      "  --dry-run         default; preview only",
      "  --apply           write the updated ops.config.json",
      "",
      "Examples:",
      '  node adapt.mjs --intent "we handle PHI now"',
      '  node adapt.mjs --intent "add stack chrome-extension" --apply',
      "",
    ].join("\n")
  );
}

export function classify(intent) {
  const sigs = [];
  const text = intent.toLowerCase();
  const hasWord = (needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Tokens with internal word chars use standard \b. Hyphenated needles
    // like 'chrome-extension' need custom boundaries because \b does not
    // break on '-'. Fall back to space/start/end of string.
    if (/^[\w]+$/.test(needle)) return new RegExp(`\\b${escaped}\\b`, "i").test(intent);
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(intent);
  };
  const hasPhrase = (phrase) => hasWord(phrase);

  // Compliance regimes.
  const complianceMap = {
    hipaa: "hipaa",
    gdpr: "gdpr",
    ccpa: "ccpa",
    soc2: "soc2",
    "iso 27001": "iso27001",
    iso27001: "iso27001",
    pci: "pci",
    mhmda: "mhmda",
    appi: "appi",
    pipa: "pipa",
    lgpd: "lgpd",
  };
  for (const [needle, value] of Object.entries(complianceMap)) {
    if (hasWord(needle)) sigs.push({ kind: "compliance:add", value });
    if (hasPhrase(`drop ${needle}`) || hasPhrase(`remove ${needle}`) || hasPhrase(`not ${needle}`)) {
      sigs.push({ kind: "compliance:drop", value });
    }
  }

  // Data classes.
  const dataClassMap = {
    phi: "phi",
    pii: "pii",
    payment: "payment",
    health: "health",
    biometric: "biometric",
    financial: "financial",
    location: "location",
  };
  for (const [needle, value] of Object.entries(dataClassMap)) {
    if (hasWord(needle)) sigs.push({ kind: "data-class:add", value });
  }

  // Stack: add / drop. Word-boundary matching so 'go' in 'going' does not fire.
  const stackMap = {
    swift: ["language", "swift"],
    typescript: ["language", "typescript"],
    python: ["language", "python"],
    go: ["language", "go"],
    rust: ["language", "rust"],
    playwright: ["testing", "playwright"],
    vitest: ["testing", "vitest"],
    jest: ["testing", "jest"],
    pytest: ["testing", "pytest"],
    xcuitest: ["testing", "xcuitest"],
    "chrome-extension": ["platform", "chrome-extension"],
    "chrome extension": ["platform", "chrome-extension"],
    ios: ["platform", "ios"],
    android: ["platform", "android"],
    web: ["platform", "web"],
  };
  for (const [needle, [axis, value]] of Object.entries(stackMap)) {
    if (
      hasPhrase(`add ${needle}`) ||
      hasPhrase(`we added ${needle}`) ||
      hasPhrase(`added a ${needle}`) ||
      hasPhrase(`now using ${needle}`)
    ) {
      sigs.push({ kind: `stack:add:${axis}`, value });
    }
    if (hasPhrase(`drop ${needle}`) || hasPhrase(`dropped ${needle}`) || hasPhrase(`removed ${needle}`)) {
      sigs.push({ kind: `stack:drop:${axis}`, value });
    }
  }

  // Audience.
  if (hasWord("b2b") || hasWord("enterprise")) sigs.push({ kind: "audience:add", value: "enterprise" });
  if (hasWord("consumer")) sigs.push({ kind: "audience:add", value: "consumer" });

  // Code-review provider switch. Only explicit command phrases to avoid
  // false positives on prose like "code review none of this".
  for (const target of CODE_REVIEW_PROVIDERS) {
    if (
      hasPhrase(`switch code-review provider to ${target}`) ||
      hasPhrase(`use ${target} for code review`) ||
      hasPhrase(`set code-review provider ${target}`)
    ) {
      sigs.push({ kind: "code-review:switch", value: target });
    }
  }
  if (hasPhrase("use external code review") || hasPhrase("switch to external code review")) {
    sigs.push({ kind: "code-review:switch", value: CODE_REVIEW_SKILL });
  }
  if (hasPhrase("use internal code review") || hasPhrase("use internal template")) {
    sigs.push({ kind: "code-review:switch", value: CODE_REVIEW_INTERNAL });
  }
  if (hasPhrase("disable code review") || hasPhrase("skip code review") || hasPhrase("no code review")) {
    sigs.push({ kind: "code-review:switch", value: CODE_REVIEW_NONE });
  }

  // Label taxonomy operations.
  if (hasPhrase("install label taxonomy") || hasPhrase("provision labels")) {
    sigs.push({ kind: "labels:install-taxonomy", value: "default" });
  }
  if (hasPhrase("sync label taxonomy") || hasPhrase("reconcile labels")) {
    sigs.push({ kind: "labels:sync-taxonomy", value: "default" });
  }
  // "extend label taxonomy with area:X" — extract the slug after "area:"
  const areaExtendMatch = intent.match(/(?:extend label taxonomy with|add area label)\s+(?:area:)?([a-z0-9][a-z0-9_-]*)/i);
  if (areaExtendMatch) {
    sigs.push({ kind: "labels:extend:area", value: areaExtendMatch[1].toLowerCase() });
  }

  // Cadence. Only explicit phrases — a stray `\bv\d+\b` match in unrelated
  // prose ("we upgraded to macOS v14") would otherwise silently mutate the
  // config on --apply.
  if (hasPhrase("continuous deploy") || hasPhrase("continuous delivery")) sigs.push({ kind: "cadence:set", value: "continuous" });
  if (hasPhrase("per wave") || hasPhrase("per-wave")) sigs.push({ kind: "cadence:set", value: "per-wave" });
  if (hasPhrase("per version") || hasPhrase("per-version")) sigs.push({ kind: "cadence:set", value: "per-version" });

  return dedupeSignals(sigs);
}

export function dedupeSignals(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const key = `${s.kind}:${s.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

export function applySignalToConfig(cfg, signal, changeLog) {
  const ensureArray = (parent, key) => {
    if (!Array.isArray(parent[key])) parent[key] = [];
    return parent[key];
  };
  cfg.compliance = cfg.compliance ?? { regimes: [], data_classes: [] };
  cfg.stack = cfg.stack ?? { language: [], testing: [], platform: [] };
  cfg.labels = cfg.labels ?? {};
  ensureArray(cfg.labels, "area");

  switch (true) {
    case signal.kind === "compliance:add": {
      if (!cfg.compliance.regimes.includes(signal.value)) {
        cfg.compliance.regimes = cfg.compliance.regimes.filter((r) => r !== "none").concat([signal.value]);
        if (!cfg.labels.area.includes(`compliance-${signal.value}`)) {
          cfg.labels.area.push(`compliance-${signal.value}`);
        }
        changeLog.push(
          `add compliance regime '${signal.value}' and label 'area/compliance-${signal.value}'`
        );
      }
      return;
    }
    case signal.kind === "compliance:drop": {
      const before = cfg.compliance.regimes.length;
      cfg.compliance.regimes = cfg.compliance.regimes.filter((r) => r !== signal.value);
      cfg.labels.area = cfg.labels.area.filter((a) => a !== `compliance-${signal.value}`);
      if (before !== cfg.compliance.regimes.length) {
        changeLog.push(
          `drop compliance regime '${signal.value}' and label 'area/compliance-${signal.value}'; flag related open issues`
        );
      }
      return;
    }
    case signal.kind === "data-class:add": {
      if (!cfg.compliance.data_classes.includes(signal.value)) {
        cfg.compliance.data_classes = cfg.compliance.data_classes.filter((d) => d !== "none").concat([signal.value]);
        changeLog.push(`add data class '${signal.value}'`);
      }
      return;
    }
    case signal.kind.startsWith("stack:add:"): {
      const axis = signal.kind.split(":")[2];
      const arr = ensureArray(cfg.stack, axis);
      if (!arr.includes(signal.value)) {
        arr.push(signal.value);
        changeLog.push(`add stack tag ${axis}=${signal.value}; may install new memory seeds`);
      }
      return;
    }
    case signal.kind.startsWith("stack:drop:"): {
      const axis = signal.kind.split(":")[2];
      const arr = ensureArray(cfg.stack, axis);
      const before = arr.length;
      cfg.stack[axis] = arr.filter((v) => v !== signal.value);
      if (before !== cfg.stack[axis].length) {
        changeLog.push(`drop stack tag ${axis}=${signal.value}; related seeds may be orphaned`);
      }
      return;
    }
    case signal.kind === "audience:add": {
      if (!cfg.labels.area.includes(`audience-${signal.value}`)) {
        cfg.labels.area.push(`audience-${signal.value}`);
        changeLog.push(`add audience label 'area/audience-${signal.value}'`);
      }
      return;
    }
    case signal.kind === "code-review:switch": {
      cfg.workflow = cfg.workflow ?? {};
      cfg.workflow.code_review = cfg.workflow.code_review ?? {};
      const prev = cfg.workflow.code_review.provider;
      cfg.workflow.code_review.provider = signal.value;
      if (prev !== signal.value) {
        changeLog.push(
          `switch code-review provider: ${prev ?? "(unset)"} -> ${signal.value}`
        );
      }
      return;
    }
    case signal.kind === "labels:install-taxonomy": {
      changeLog.push(
        "install canonical label taxonomy from templates/labels/default-taxonomy.yaml (via gh label create)"
      );
      return;
    }
    case signal.kind === "labels:sync-taxonomy": {
      changeLog.push(
        "sync label taxonomy: compare repo labels against taxonomy + extensions, report diffs"
      );
      return;
    }
    case signal.kind === "labels:extend:area": {
      cfg.labels = cfg.labels ?? {};
      cfg.labels.taxonomy = cfg.labels.taxonomy ?? {};
      cfg.labels.taxonomy.extensions = cfg.labels.taxonomy.extensions ?? {};
      const areas = cfg.labels.taxonomy.extensions.areas ?? [];
      if (!areas.includes(signal.value)) {
        areas.push(signal.value);
        cfg.labels.taxonomy.extensions.areas = areas;
        changeLog.push(
          `extend label taxonomy: add area:${signal.value} to labels.taxonomy.extensions.areas`
        );
      }
      return;
    }
    case signal.kind === "cadence:set": {
      const prev = cfg.workflow?.phase_term;
      cfg.workflow = cfg.workflow ?? {};
      // Continuous cadence gets `track` (matches bootstrap.mjs compose).
      cfg.workflow.phase_term =
        signal.value === "per-version" ? "version" : signal.value === "continuous" ? "track" : "wave";
      if (prev !== cfg.workflow.phase_term) {
        changeLog.push(
          `switch cadence: workflow.phase_term ${prev} -> ${cfg.workflow.phase_term}; release-tracker will recompute umbrellas`
        );
      }
      return;
    }
    default:
      return;
  }
}

export function buildNonConfigPlan(signals, current, proposed) {
  const steps = [];
  const addedLabels = diffArray(current.labels?.area ?? [], proposed.labels?.area ?? []).added;
  const removedLabels = diffArray(current.labels?.area ?? [], proposed.labels?.area ?? []).removed;
  if (addedLabels.length) steps.push(`via tracker-sync: create labels ${addedLabels.map((l) => `area/${l}`).join(", ")}`);
  if (removedLabels.length) steps.push(`via tracker-sync: list open issues carrying ${removedLabels.map((l) => `area/${l}`).join(", ")} before removing labels`);

  const stackBefore = current.stack ?? {};
  const stackAfter = proposed.stack ?? {};
  for (const axis of ["language", "testing", "platform"]) {
    const d = diffArray(stackBefore[axis] ?? [], stackAfter[axis] ?? []);
    if (d.added.length) steps.push(`run install_memory_seeds.mjs --update to install seeds tagged ${axis}=${d.added.join(",")}`);
    if (d.removed.length) steps.push(`review memory seed wrappers tagged ${axis}=${d.removed.join(",")}; they may now be orphaned`);
  }

  if (signals.some((s) => s.kind === "compliance:add")) {
    steps.push("consider authoring a rules/product-<regime>.md (portable: false) to capture new obligations");
  }
  return steps;
}

export function diffArray(before, after) {
  const bSet = new Set(before);
  const aSet = new Set(after);
  return {
    added: [...aSet].filter((x) => !bSet.has(x)),
    removed: [...bSet].filter((x) => !aSet.has(x)),
  };
}
