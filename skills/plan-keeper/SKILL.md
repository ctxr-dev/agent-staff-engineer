---
name: plan-keeper
description: Enforces the plan folder layout, checkbox format, frontmatter contract, and lifecycle moves (todo -> in-progress -> in-review -> done). Keeps plan one-liners in sync with GitHub issues. Does not write to daily/ or knowledge/.
trigger_on:
  - A plan file needs to move state (todo -> in-progress, in-progress -> in-review, etc.).
  - Dev-loop flips a plan one-liner on gate crossings.
  - User creates or edits a plan file and asks for validation.
  - After adapt-system if plan_states or done_pattern changed.
do_not_trigger_on:
  - The project's daily report folder. Not touched, ever.
  - The project's knowledge base. Not touched, ever.
  - Plans outside the configured plans_root.
  - A plan one-liner flip would contradict the linked PR's current status as reported by `github-sync` (plan says `[x]` but PR says "In progress"), OR a plan claims a `related_github_issues` that no longer exists / has been reopened unexpectedly. Follow `rules/ambiguity-halt.md` (halt, surface the observation, ask); do not flip the checkbox or move the plan state while the question is open.
writes_to_github: no
writes_to_filesystem: plan files within paths.plans_root only
---

# plan-keeper

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if missing or invalid.

The plan keeper owns structure, not content. It does not decide what a plan says; it ensures every plan file sits in the right folder, carries the right frontmatter, uses checkboxes, and moves through the lifecycle cleanly.

**Explicit non-goals:** never writes to `daily/`, `knowledge/`, or any folder outside `paths.plans_root`. Other systems in the project own those; the agent stays out.

## Inputs

- A plan file path (or a directory scan when invoked with no path).
- Optional target state (e.g. `--move in-review`) or a structure-fix request (`--fix-frontmatter`).

## Outputs

- The plan file, moved to the target folder and renamed where the lifecycle requires (the `done/` folder follows `paths.done_pattern`).
- Updated frontmatter (missing fields filled with sensible defaults or explicit `TBD`).
- A one-line stdout note of what changed.

## Plan folder layout

From `paths.plans_root` (default `.claude/plans/`), the state folders listed in `paths.plan_states` (default `todo`, `in-progress`, `in-review`, `blocked`, `done`) each contain flat plan files, with one exception: `done/` is nested per `paths.done_pattern` (default `done/{yyyy}/{mm}/{dd}/{slug}`).

```text
.claude/plans/
  todo/
    <slug>.md
  in-progress/
    <slug>.md           or <slug>/ for multi-file plans
  in-review/
    <slug>.md
  blocked/
    <slug>.md
  done/
    2026/
      04/
        17/
          <slug>.md     or <slug>/
```

## Frontmatter contract

Every plan file (regardless of state) has YAML frontmatter with at minimum:

- `title` (string, required)
- `created` (YYYY-MM-DD, required; never auto-updated after creation)
- `owner` (string, required)
- `status` (enum matching `paths.plan_states`, required; kept consistent with the folder location)
- `related_github_issues` (array of `#NNN` references, optional)
- `related_release_umbrella` (`#NNN`, optional)
- `expected_completion` (YYYY-MM-DD, optional)

The keeper fills missing required fields with explicit `TBD` values and prints a warning.

## Checkbox format

Every actionable item in a plan is a GitHub-style checkbox (`- [ ]` or `- [x]`), regardless of plan size. Sub-items nest with standard indentation, still as checkboxes. Bare bullets are allowed only for contextual narrative, never for actionable items.

## Lifecycle moves

```text
create     -> paths.plans_root/todo/<slug>.md
start work -> paths.plans_root/in-progress/<slug>.md
await gate -> paths.plans_root/in-review/<slug>.md
external  -> paths.plans_root/blocked/<slug>.md
blocker
finished  -> paths.plans_root/done/{yyyy}/{mm}/{dd}/<slug>.md
           (yyyy/mm/dd = the completion date, not the created date)
```

On every move, the skill:

1. Validates frontmatter.
2. Updates `status` to match the new folder.
3. Normalises checkbox formatting.
4. Preserves the rest of the file content byte-for-byte.

## GitHub link sync

When a plan's `related_github_issues` references issues, the skill can (via `github-sync` read-only) confirm the issues still exist and note any status changes next to the one-liner. It never edits the issue body or its status; that is `github-sync`'s job under other skills' approval.

When `workflow.pr.update_plan_oneliner` is true and `dev-loop` crosses a gate, `dev-loop` asks `plan-keeper` to flip the corresponding one-liner checkbox. The keeper's job is the move, not the decision.

## Idempotency

- Running the keeper against a well-formed plan in the right folder is a no-op.
- Re-running a move that already happened is a no-op.
- Normalising an already-normalised file is a no-op.

## Guardrails

- Will not touch any file outside `paths.plans_root`.
- Will not create, read, or modify any path matching `daily/*`, `knowledge/*`, or any path not under `paths.plans_root` / `paths.dev_working_dir` / `paths.templates`.
- Refuses to move a plan file that has uncommitted merge conflicts or broken frontmatter; surfaces the exact issue.

## Failure modes

- **Frontmatter invalid (YAML parse error)**: halt, point at the bad line.
- **Target folder missing**: create it, note in stdout.
- **Slug collision on move**: refuse, suggest a disambiguating slug (date suffix or numeric tiebreak).
- **Plan uses em or en dashes (U+2014 or U+2013) in the content**: warn but do not rewrite; point at `rules/no-dashes.md` and let the author decide.

## Cross-skill handoffs

- `github-sync` (read-only only) for link sync.
- Called by `dev-loop` for one-liner flips.
- Called by `adapt-system` after `paths.*` changes (migrate existing plans into new folder names).

## Project contract

- `paths.plans_root`, `paths.plan_states`, `paths.done_nested`, `paths.done_pattern`.
- `paths.dev_working_dir` (referenced only to refuse writes outside plans_root).
- `workflow.pr.update_plan_oneliner` (whether to honour requests from `dev-loop`).
- `labels.state_modifiers` (to align plan frontmatter with blocker/deferred conditions).
- Never reads or writes anything outside the above.
