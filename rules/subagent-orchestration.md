---
name: subagent-orchestration
description: Binding contract for when and how the agent delegates work to Soldier subagents via the Agent tool. Captains own the conversation and plan; Soldiers do the reading + editing + reviewing; every Soldier returns a structured JSON report validated against schemas/soldier-report.schema.json. Soldiers honour every existing bundle rule the Captain honours.
portable: true
scope: every session where the agent considers dispatching a Soldier subagent via the Agent tool
---

# Subagent orchestration

## The rule

Claude Code's `Agent` tool is the primitive for subagent dispatch. On this bundle, a Captain (the root session talking to the user) uses that primitive under a specific contract, enforced here:

- **Captain** = the root session. Talks to the user, owns the plan file, owns the session's context budget, makes user-facing decisions, runs the final verification.
- **Soldier** = a single `Agent` tool invocation. Does one bounded task. Returns a structured JSON report. Dies when the invocation ends.

Soldiers do NOT talk to the user. Soldiers do NOT own plan state. Soldiers do NOT make the final verification. The Captain reads the report, trusts-but-verifies, and decides the next step.

## When to delegate

The Captain delegates when at least one of the following triggers fires:

1. **Reading budget**: the task would pull >200 lines of file content into the Captain's context.
2. **Search breadth**: the task needs >3 independent Grep / Glob / Explore queries to answer.
3. **Cross-skill scope**: the task spans two skills (eg "run code review AND fix the findings"). Split so each Soldier owns one skill's surface.

If none of these triggers fires, the Captain does the task directly. Delegation has fixed overhead (briefing, return-trip, report parsing); short atomic tasks are cheaper in-line.

The Captain never delegates for reasons outside these triggers. No "just to be safe", no "the user might want parallelism", no "it feels cleaner". The triggers exist so delegation earns its cost.

## Roles of Soldier

Three canonical shapes. Every Soldier fits one:

- **Explorer** (read-only): search / survey / map a part of the codebase or tracker. Never writes. Safe to fan out in parallel.
- **Implementer** (write): execute a bounded edit plan on a named file set. Cites every file it touched in the report's `artefacts` array.
- **Reviewer** (read + verdict): runs analysis on a diff or file tree. Returns findings as structured JSON; never writes.

Each shape has a canonical briefing template in `skills/orchestrator/SKILL.md`. The Captain copies the template, fills the vars, passes the resulting prompt string to the Agent tool. The template is the minimum; Captains may add task-specific context, never subtract from the required frame.

## Parallelisation heuristics

Soldiers run in parallel when ALL of the following hold:

- **Non-overlapping file sets.** Soldier A edits `scripts/**`, Soldier B edits `tests/**`. Never both touch `tests/bootstrap.test.mjs`.
- **Non-overlapping skill surfaces.** At most one Soldier per bundled skill at a time.
- **No required sequencing.** "Reviewer produces findings, Implementer fixes them" is sequential; "Explorer A maps `skills/`, Explorer B maps `rules/`" is parallel.

Read-only fan-out (N Explorers scanning different parts) is always safe. Writes need explicit non-overlap checks.

When the Captain cannot prove non-overlap up front, the tasks run sequentially.

## Handoff protocol

Every Soldier's return is a JSON object validated against [schemas/soldier-report.schema.json](../schemas/soldier-report.schema.json). Fields:

- `status`: `"done"` | `"failed"` | `"partial"`.
- `summary`: ≤2,400 characters (one screen). What the Soldier actually did, in plain language.
- `artefacts`: array of filesystem paths the Soldier read, wrote, or cited. Must be non-empty for Implementers; may be empty for Explorers.
- `blockers` (optional): array of short strings. Populated only when `status` is `partial` or `failed`.
- `nextStep` (optional): single short string the Captain should consider next.

The Captain MUST verify at least one claim in `summary` against the actual filesystem before acting on the report. This is the "trust but verify" discipline baked in: a Soldier saying "I edited `scripts/lib/foo.mjs`" does not equal the edit having landed.

When the report fails schema validation, the Captain halts and surfaces the discrepancy. It does not edit the report. It does not retry the Soldier. Schema failure is a bug in the Soldier's briefing or in the task itself; the Captain asks the user.

## Inherited invariants

**Soldiers honour every existing bundle rule the Captain honours.** The Agent tool does not grant a bypass. In particular:

- **[rules/tracker-source-of-truth.md](tracker-source-of-truth.md)**: Soldiers that need to read or write tracker state go through `tracker-sync`. Direct `gh` / `jira` / `linear` / `glab` calls from a Soldier are forbidden.
- **[skills/tracker-sync/SKILL.md](../skills/tracker-sync/SKILL.md)** as the sole tracker writer: same invariant.
- **[skills/plan-keeper/SKILL.md](../skills/plan-keeper/SKILL.md)** as the sole plan-file writer: Soldiers never write under `paths.plans_root` directly; they return the intended change in the report and the Captain invokes `plan-keeper`.
- **[rules/pr-workflow.md](pr-workflow.md)** human gates: Soldiers never merge a PR or flip a dev issue to Done. Same for Reviewers that might feel "this is ready".
- **[rules/llm-wiki.md](llm-wiki.md)**: Soldiers writing under `.development/**` go through `@ctxr/skill-llm-wiki` (or, for scratch state, through `scripts/lib/sessionState.mjs`). Never write raw files under wiki-governed topics.
- **[rules/ambiguity-halt.md](ambiguity-halt.md)**: when a Soldier hits ambiguity, it returns `status: "partial"` with `blockers` populated. It does NOT ask the user (that belongs to the Captain) and it does NOT guess.
- **[rules/no-dashes.md](no-dashes.md)**: Soldiers author PR bodies, issue comments, report summaries. The no-em-dash rule applies to everything they emit.

## Exceptions to the self-contained briefing rule

The "every Soldier briefing is self-contained" norm has two documented exceptions:

1. **Explore agents fanned out during Phase 1 of planning** per [memory-seeds/planning-parallel-agents.md](../memory-seeds/planning-parallel-agents.md) inherit context from the planning session by design. These are not Implementers or Reviewers with write intent; they are Captain-led reconnaissance. The briefing may reference the planning question directly.
2. **The external `ctxr-skill-code-review` subagent** is its own configured surface. It consumes a diff and returns a code-review verdict; it does not conform to the Implementer / Reviewer briefing shape because its briefing lives in the external skill. Treat its return value as a Reviewer report but do not require it to match `soldier-report.schema.json`.

Every other Soldier follows the self-contained-briefing rule.

## Cancellation and timeouts

A Soldier invocation can take minutes (large-scope edits, deep searches). The Captain:

- Does NOT attempt to cancel a running Agent call mid-flight. There is no cancel surface today; the tool's own timeout is the bound.
- Sets task-appropriate scope in the briefing. "Audit every file under X" is unbounded; "Audit the 12 files in `diff main..HEAD`" is bounded.
- When a Soldier returns `status: "partial"` with a timeout-like blocker, the Captain splits the task into narrower sub-scopes rather than retrying the same briefing.

## Related

- [skills/orchestrator/SKILL.md](../skills/orchestrator/SKILL.md): the how-to, with the three briefing templates, worked examples, and anti-patterns.
- [schemas/soldier-report.schema.json](../schemas/soldier-report.schema.json): the structured return contract.
- [memory-seeds/delegation-triggers.md](../memory-seeds/delegation-triggers.md): memory seed that travels to every installed project.
- [memory-seeds/planning-parallel-agents.md](../memory-seeds/planning-parallel-agents.md): the other delegation-adjacent seed; applies specifically to Phase-1 Explore fan-out.
- [rules/ambiguity-halt.md](ambiguity-halt.md): the halt protocol Soldiers follow on thin facts.
