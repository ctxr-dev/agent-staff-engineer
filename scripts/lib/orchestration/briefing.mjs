// lib/orchestration/briefing.mjs
// Pure-JS helper for assembling a Soldier briefing string the Captain
// passes to the Agent tool as `prompt`. The briefing templates live
// in skills/orchestrator/SKILL.md as canonical prose; this module
// mirrors them in code so programmatic callers (tests, future skills
// that compose briefings) get a single source of truth.
//
// No I/O. No runtime deps. The return value is a plain string.
//
// Usage:
//   import { buildBriefing, SHAPES } from "./briefing.mjs";
//   const prompt = buildBriefing("explorer", {
//     task_description: "…",
//     scope_description: "…",
//     out_of_scope: "…",
//     starting_points: "…",
//   });
//   // pass prompt to the Agent tool

/**
 * The three Soldier shapes the project's orchestration contract
 * recognises. Exported as a frozen array so test assertions can
 * enumerate without risk of mutation.
 */
export const SHAPES = Object.freeze(["explorer", "implementer", "reviewer"]);

/**
 * Required briefing variables per shape. Extra vars beyond these are
 * rejected by `buildBriefing` to catch caller typos before the brief
 * goes out the door (the Agent tool will happily run any prompt; we
 * want the failure early).
 *
 * Keep in lockstep with the templates below AND with the Agent-facing
 * prose in skills/orchestrator/SKILL.md. The test suite asserts both
 * sides match.
 */
export const REQUIRED_VARS = Object.freeze({
  explorer: Object.freeze([
    "task_description",
    "scope_description",
    "out_of_scope",
    "starting_points",
  ]),
  implementer: Object.freeze([
    "task_description",
    "file_scope",
    "acceptance_criteria",
    "verification_plan",
  ]),
  reviewer: Object.freeze([
    "task_description",
    "review_scope",
    "rubric",
    "out_of_scope",
  ]),
});

const TEMPLATES = Object.freeze({
  explorer: `You are an Explorer Soldier for the agent-staff-engineer project.

Your job is to SURVEY, not change. You may read files, run Grep / Glob /
find-style searches, and enumerate things. You may NOT edit any file, call
any tracker API (tracker-sync is off-limits), or ask the user anything.

Return a JSON object that validates against
schemas/soldier-report.schema.json:
  - status: "done" | "partial" | "failed"
  - summary: ≤2,400 chars. What you found, in plain language.
  - artefacts: array of filesystem paths you read (may be empty if none).
  - blockers: optional array of short strings. Populated only when you
    hit ambiguity per rules/ambiguity-halt.md and cannot classify a
    finding.
  - nextStep: optional short string. What the Captain should consider next.

Task:

{{task_description}}

Scope:

{{scope_description}}

Out of scope (do not investigate):

{{out_of_scope}}

Useful starting points:

{{starting_points}}

Remember: no writes, no tracker calls, no user prompts. Return the JSON
report as your FINAL message.`,
  implementer: `You are an Implementer Soldier for the agent-staff-engineer project.

Your job is to EDIT a bounded file set and return a structured report.
You WILL: read files in scope, edit files in scope, run the test suite,
surface what changed. You will NOT: edit files outside the declared scope,
call any tracker API (tracker-sync is off-limits except when this briefing
explicitly names a tracker-sync call), ask the user anything, or merge /
close any PR.

You honour every bundle rule the Captain honours. In particular:
rules/pr-workflow.md (two human gates stay human), rules/no-dashes.md
(no em or en dashes), rules/tracker-source-of-truth.md (tracker writes go
through tracker-sync if at all). If you hit ambiguity per
rules/ambiguity-halt.md, return status "partial" with blockers populated.

Return a JSON object that validates against
schemas/soldier-report.schema.json:
  - status: "done" | "partial" | "failed"
  - summary: ≤2,400 chars. What you edited + why.
  - artefacts: non-empty array of every file you wrote or created
    (absolute paths or project-relative). Required.
  - blockers: optional array of short strings on partial / failed.
  - nextStep: optional short string.

Task:

{{task_description}}

File scope (you may edit these; you MUST NOT edit anything else):

{{file_scope}}

Acceptance criteria:

{{acceptance_criteria}}

Verification:

{{verification_plan}}

Return the JSON report as your FINAL message.`,
  reviewer: `You are a Reviewer Soldier for the agent-staff-engineer project.

Your job is to ANALYSE and return findings. You may read files and diffs.
You MUST NOT edit files, call any tracker API, or ask the user anything.
You do NOT decide merge / ship; that is the Captain's (and ultimately the
user's) call.

Return a JSON object that validates against
schemas/soldier-report.schema.json:
  - status: "done" | "partial" | "failed"
  - summary: ≤2,400 chars. Your verdict + the most important findings,
    in plain language.
  - artefacts: array of files you reviewed (may be empty if you worked
    only from the diff).
  - blockers: optional array on partial / failed.
  - nextStep: optional short string (eg "spawn an Implementer to
    address findings 1, 3, 5").

Task:

{{task_description}}

Review scope:

{{review_scope}}

Rubric (what to flag):

{{rubric}}

Out of scope (do not flag):

{{out_of_scope}}

Return the JSON report as your FINAL message.`,
});

/**
 * Build a Soldier briefing string by filling the shape's template
 * with `vars`. Validates:
 *   - `shape` is one of SHAPES.
 *   - `vars` contains every key in REQUIRED_VARS[shape] and no extras.
 *   - every provided var is a non-empty string (templates embed them
 *     verbatim; null / number / object inputs would render "null" /
 *     "42" / "[object Object]" which is never what the caller wanted).
 *
 * Throws TypeError on shape or vars violations. Returns the filled
 * template on success.
 *
 * The function is pure: no I/O, no side effects, deterministic for a
 * given input.
 */
export function buildBriefing(shape, vars) {
  if (typeof shape !== "string" || !SHAPES.includes(shape)) {
    throw new TypeError(
      `buildBriefing: shape must be one of ${JSON.stringify(SHAPES)}; got ${JSON.stringify(shape)}`,
    );
  }
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) {
    throw new TypeError(
      `buildBriefing: vars must be a plain object; got ${JSON.stringify(vars)}`,
    );
  }
  const required = REQUIRED_VARS[shape];
  const provided = Object.keys(vars);
  const missing = required.filter((k) => !(k in vars));
  if (missing.length > 0) {
    throw new TypeError(
      `buildBriefing(${shape}): missing required vars [${missing.join(", ")}]`,
    );
  }
  const extras = provided.filter((k) => !required.includes(k));
  if (extras.length > 0) {
    throw new TypeError(
      `buildBriefing(${shape}): unknown vars [${extras.join(", ")}]; expected ${JSON.stringify([...required])}`,
    );
  }
  for (const k of required) {
    const v = vars[k];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new TypeError(
        `buildBriefing(${shape}): var '${k}' must be a non-empty string; got ${JSON.stringify(v)}`,
      );
    }
  }
  // Single-pass substitution over the ORIGINAL template. A
  // sequential split/join pass would re-scan already-injected var
  // values on later iterations, so a caller whose `task_description`
  // happened to contain the literal `{{out_of_scope}}` would have
  // that injected text substituted too. One regex pass guarantees
  // each placeholder is replaced exactly once by the value it
  // names, regardless of what's in the other vars.
  //
  // The replacement callback returns the var value as a string
  // constant; String.replace's $-substitution in the replacement
  // is bypassed when passing a function callback (vs a string),
  // so `$1` / backslashes / other regex metacharacters in var
  // values pass through verbatim.
  const requiredSet = new Set(required);
  return TEMPLATES[shape].replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) =>
    requiredSet.has(key) ? vars[key] : match,
  );
}

/**
 * Return the raw template text for a shape. Primarily for tests that
 * assert the templates in skills/orchestrator/SKILL.md match the
 * strings in this file; callers building actual briefings should use
 * `buildBriefing` so required-vars enforcement kicks in.
 */
export function templateFor(shape) {
  if (!SHAPES.includes(shape)) {
    throw new TypeError(
      `templateFor: shape must be one of ${JSON.stringify(SHAPES)}; got ${JSON.stringify(shape)}`,
    );
  }
  return TEMPLATES[shape];
}
