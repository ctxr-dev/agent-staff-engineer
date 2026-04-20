---
name: plan-management
description: Folder layout, checkbox format, frontmatter contract, and lifecycle moves for plan files. Plans stay inside the configured plans_root. Never touches daily/ or knowledge/.
portable: true
scope: plan-keeper skill plus any skill that creates or updates a plan file
---

# Plan management

## The rule

Plans live under `ops.config.json -> paths.plans_root` (default `.claude/plans/`). Every plan is a markdown file with frontmatter, GitHub-style checkbox items for actionable work, and a one-liner for each linked issue. Plans move through configured lifecycle states in one direction; the `done/` state is nested by completion date.

The agent never reads or writes any path outside `paths.plans_root`, `paths.dev_working_dir`, and `paths.templates`. In particular, the agent does not touch `daily/`, `knowledge/`, or similar systems the target project runs through its own hooks.

## Folder layout

```text
{{ paths.plans_root }}/
  todo/
    <slug>.md                 one plan per file, or one folder per plan for multi-file plans
  in-progress/
    <slug>.md
  in-review/
    <slug>.md
  blocked/
    <slug>.md
  done/
    {yyyy}/
      {mm}/
        {dd}/
          <slug>.md
```

The state folders come from `paths.plan_states`. The `done/` nesting comes from `paths.done_pattern`. Only `done/` is nested by date. Every other state folder is flat.

## Frontmatter contract

Every plan file starts with YAML frontmatter:

```yaml
---
title: <short human title>
created: YYYY-MM-DD
owner: <name or login>
status: <one of paths.plan_states>
related_github_issues: ["#NNN", "#MMM"]     # optional
related_release_umbrella: "#OOO"             # optional
expected_completion: YYYY-MM-DD              # optional
---
```

Required fields are `title`, `created`, `owner`, `status`. Missing required fields get `TBD` with a warning. `status` must match the folder the file currently sits in.

## Checkbox format

Every actionable item is a GitHub-style checkbox:

- `- [ ]` for pending.
- `- [x]` for done.

Sub-items nest with standard indentation, still as checkboxes:

```markdown
- [ ] Top-level action
  - [ ] Sub-action 1
  - [x] Sub-action 2
```

Bare bullets (`- something`) are allowed only for contextual narrative, never for actionable items. If in doubt, make it a checkbox.

## One-liner per linked issue

When a plan references a GitHub issue, the plan lists that issue as a one-liner:

```markdown
- [ ] Migrate auth middleware #123
- [x] Drop legacy session table #145
```

The plan does not duplicate the issue body. Full context lives in GitHub.

## Lifecycle moves

A plan moves through states in one direction:

1. Created at `{{ paths.plans_root }}/todo/<slug>.md`.
2. Moves to `in-progress/` when work begins.
3. Optionally routes through `in-review/` when waiting for a gate, or `blocked/` on external dependency.
4. Lands at `done/{yyyy}/{mm}/{dd}/<slug>.md` on the **completion** date, not the created date.

On every move, the keeper:

- Updates `status` in the frontmatter.
- Normalises checkboxes (no bare bullets for actionable items).
- Preserves the rest of the content byte-for-byte.

## What the agent does not do

- Does not read any path outside the configured plan paths.
- Does not write a plan-completion entry into a daily report, a knowledge file, or any file outside `paths.plans_root`.
- Does not rename a plan silently. A slug collision on move triggers a refusal and a suggested disambiguation.
- Does not edit the issue body in GitHub to match the plan. GitHub is the source of truth; the plan one-liner gets rewritten from GitHub when the two disagree.

## Multi-file plans

A plan that needs multiple files is a folder rather than a file:

```text
{{ paths.plans_root }}/in-progress/complex-feature/
  README.md                frontmatter lives here
  design.md
  risk.md
  checklist.md
```

The frontmatter sits in `README.md`. Lifecycle moves apply to the folder as a whole.

## How this plays with rotation

- The agent follows `dev-loop` gate crossings to flip a plan's one-liner from `[ ]` to `[x]`, only when `ops.config.json -> workflow.pr.update_plan_oneliner` is true.
- The one-liner's checkbox state follows the issue status returned by `tracker-sync`. If the issue is Done, the checkbox is `[x]`. If the issue reopened, the checkbox is `[ ]` again.
- A plan moves to `done/` only on the user's explicit say-so. The agent never infers "done" from a count of checked boxes.

## Related rules

- [tracker-source-of-truth.md](tracker-source-of-truth.md): plans are projections.
- [pr-workflow.md](pr-workflow.md): the dev-loop that triggers one-liner flips.
- [no-dashes.md](no-dashes.md): applies to the prose inside plan files.
