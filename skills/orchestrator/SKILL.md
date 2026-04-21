---
name: orchestrator
description: How-to for the Captain/Soldier delegation pattern. Contains the three briefing templates (Explorer, Implementer, Reviewer), worked examples, and the anti-pattern list. The binding rule lives at rules/subagent-orchestration.md; this skill is the operator's reference for writing a well-formed Soldier brief.
trigger_on:
  - The Captain decides to delegate per the triggers in rules/subagent-orchestration.md (reading >200 lines, >3 search queries, or cross-skill scope).
  - A skill's own SKILL.md invokes "delegate the X step as an Implementer Soldier" or similar and the Captain needs the canonical briefing shape.
do_not_trigger_on:
  - Short atomic tasks the Captain can finish in-line without exceeding the delegation triggers.
  - User-facing decisions (those stay with the Captain; Soldiers never talk to the user).
  - Soldiers invoked from OTHER bundled skills that already fully specify the briefing. This skill is the operator reference, not a library skills chain through.
writes_to_github: no (Soldiers that write go through tracker-sync; this skill is just the briefing + parsing layer)
writes_to_filesystem: no (Soldiers that write files are documented here but the skill itself does not write)
---

# orchestrator

Before acting, read [rules/subagent-orchestration.md](../../rules/subagent-orchestration.md). That rule is the binding contract; this skill is the how-to. Everything below assumes the rule's triggers, inherited invariants, and parallelisation heuristics are already satisfied; the skill addresses WHAT the brief says when delegation is already decided.

## The three Soldier shapes

Every Soldier fits one of three shapes. Pick the shape first; choose the template second; fill the vars last.

- **Explorer** (read-only): scan / search / map. Returns structured findings. Never writes. Safe to fan out in parallel.
- **Implementer** (write): execute a bounded edit plan on a named file set. Writes files, runs tests, surfaces what changed.
- **Reviewer** (read + verdict): analyse a diff or file tree against a contract (code quality, schema invariants, compliance). Returns findings; never writes.

When a task spans shapes (eg "review the diff AND fix the findings"), split it. Run the Reviewer first; take its findings as input to a subsequent Implementer brief. Do NOT blend shapes in a single Soldier.

## Briefing templates

The Captain assembles a plain-text prompt (the same string the Agent tool takes) by filling the relevant template. Every template starts with the self-contained frame (who the Soldier is, what it must return) and ends with the task-specific body.

Nothing below is machine-parsed; the Soldier reads the plain text and obeys. Templates are documented in [scripts/lib/orchestration/briefing.mjs](../../scripts/lib/orchestration/briefing.mjs) as named helpers (`buildBriefing(shape, vars)`); use the helper for programmatic assembly, or copy the template directly into the Agent tool's `prompt` parameter.

### Explorer briefing

```text
You are an Explorer Soldier for the agent-staff-engineer project.

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
report as your FINAL message.
```

### Implementer briefing

```text
You are an Implementer Soldier for the agent-staff-engineer project.

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
rules/ambiguity-halt.md, return `status: "partial"` with blockers populated.

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

Return the JSON report as your FINAL message.
```

### Reviewer briefing

```text
You are a Reviewer Soldier for the agent-staff-engineer project.

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

Return the JSON report as your FINAL message.
```

## Worked examples

### Example 1: "Investigate why test X is flaky" (one Explorer)

Trigger: the task needs >3 Grep queries (test file, runner config, recent history, related tests). Reading budget is <200 lines. Single skill surface. → Delegate as one Explorer.

Briefing fills:

- `task_description`: "Classify the flakiness in `tests/trackers_github_projects.test.mjs::paginates across pages until limit hits`. Is it an ordering bug, a timing bug, a fixture bug, or something else?"
- `scope_description`: "`tests/trackers_github_projects.test.mjs`, `scripts/lib/trackers/github.mjs#githubListProjectItems`, the fake-gh fixtures at the top of the test file."
- `out_of_scope`: "Do not look at other tracker tests. Do not look at the production gh CLI."
- `starting_points`: "`grep -n 'paginates' tests/trackers_github_projects.test.mjs`; follow the fixture names back to FIX_JSON."

Captain reads the returned report, verifies at least one cited finding (eg opens the exact file + line the Soldier cited), and decides the next step. Often the follow-up is an Implementer brief to apply the fix.

### Example 2: "Refactor `scripts/lib/foo.mjs` + update its 4 call sites" (two parallel Implementers)

Trigger: task spans a lib change AND 4 caller updates. If the lib change is small, one Implementer can do both. If the lib change is >200 lines or the caller patterns are repetitive, split so the Captain can review in pieces.

- **Soldier A (Implementer)**: file scope = `scripts/lib/foo.mjs`. Task: refactor the exported surface. Acceptance: existing tests for the lib still pass.
- **Soldier B (Implementer)**: file scope = the 4 caller files. Task: update call sites to the new surface. Acceptance: `npm test` passes.

Parallel is safe IFF the file sets are disjoint (Soldier A's scope is the lib file; Soldier B's is the 4 callers) and each can be verified independently. When the 4 callers import types from the lib AND the lib's type exports change, the tasks are actually sequential (B depends on A's output); run them one at a time.

### Example 3: "Full PR review + fix cycle" (Reviewer then Implementer)

- **Soldier 1 (Reviewer)**: scope = the diff `main..HEAD`. Task: apply the code-review rubric (clean-code-solid, test-quality, security, release-readiness). Returns structured findings.
- **Soldier 2 (Implementer)**: file scope = the files flagged in Soldier 1's findings. Task: apply findings 1, 3, 5 from the Reviewer report (pass the findings text as part of the briefing). Acceptance: tests pass.

Sequential, not parallel. The Captain reads the Reviewer report, picks which findings to act on (not all are always actionable), and briefs the Implementer with the selected subset.

## Anti-patterns

1. **Delegating a user-facing question.** "Ask the user which option they prefer" is never a Soldier task. The Captain runs the conversation. Soldiers never speak to the user.
2. **Delegating the final verification.** After the Soldier returns, the Captain verifies. The Captain does not spawn a second Soldier to verify the first Soldier.
3. **Delegating atomic single-file edits <30 lines.** The Agent overhead (briefing + parsing) costs more than the edit. Captain does it directly.
4. **Sharing file scope between parallel writers.** Both Implementer A and B touching `tests/bootstrap.test.mjs` is a bug. Pre-check non-overlap or run sequentially.
5. **Blending shapes.** "Review the diff AND fix the findings" is two Soldiers, not one. Keep the verdict separate from the edit so the Captain can re-use the Reviewer's findings if the Implementer stalls.
6. **Briefing that relies on the parent session's context.** Every Implementer / Reviewer Soldier briefing must be self-contained. The Soldier cannot see the user's message stream or the plan file; everything it needs must be in the briefing text.
7. **Trusting the Soldier's report blind.** Always verify at least one claim from the summary against the actual filesystem before acting. Soldiers have a 10-20% hallucination rate on "I wrote / edited this file" when they didn't.
8. **Running a Soldier that edits plan files.** `plan-keeper` is the sole writer under `paths.plans_root`. Soldiers return the intended plan change in their report; the Captain calls `plan-keeper`.
9. **Running a Soldier that calls tracker APIs directly.** `tracker-sync` is the sole writer on every tracker surface. If the Soldier needs to read or write a tracker, it goes through `tracker-sync`.
10. **Delegating the ambiguity halt itself.** A Soldier that hits ambiguity returns `status: "partial"` with blockers. The user-facing halt message is the Captain's to write.

## Cross-skill handoffs

- **`dev-loop`**: the "local review" and "self-review" stages are canonical Reviewer Soldiers when the reading budget exceeds the delegation trigger. The "implement" stage is an Implementer Soldier when the edit set is bounded and the scope is clear.
- **`pr-iteration`**: each round's "triage unresolved threads + fix" step is an Implementer Soldier when the fix spans multiple files; smaller fixes stay in-line.
- **`regression-handler`**: the "search for causing commit / issue / PR" is an Explorer Soldier.
- **`adapt-system`**: the "propose diff" step is a Reviewer (compute the cascading diff) followed by an Implementer (apply the preview-approved diff). The Captain remains the one asking the user to approve.
- **`issue-discovery`**: the "pre-fetch open issues + score areas against intent" pre-load is an Explorer Soldier; the per-interview conversation stays on the Captain.
- **`plan-keeper`**: read-only. No delegation needed; plan-keeper's operations are cheap and Captain-owned.

## Project contract

- `workflow.orchestration.enabled` (optional; default true): master switch. When false, the Captain never dispatches Soldiers; every task runs inline. Useful on projects where delegation overhead isn't worth it.
- `workflow.orchestration.max_parallel_soldiers` (optional; default 3): upper bound on simultaneous Agent calls. Claude Code's common cap is 3; raising it is untested territory.
- `workflow.orchestration.session_log` (optional; default `.development/local/orchestration/session.log`): where the Captain records dispatched briefings + returned reports for post-hoc inspection. Session-scoped and gitignored per the `.development/local/` convention.
