---
name: adapt-system
description: Takes free-form user intent that reshapes the project (new domain, stack, compliance, audience, dropped dependency) and proposes a cascading diff across ops.config.json, labels, templates, rules, and memory seeds. Idempotent, diff-previewed, never silent.
trigger_on:
  - User describes the project in a way that changes its shape ("we handle PHI now", "we added a Chrome extension target", "we dropped TelemetryDeck", "this is B2B now").
  - User explicitly runs /adapt-system with an intent.
  - After a bundle --update when the new schema introduces keys not present in the current config.
do_not_trigger_on:
  - First install; use bootstrap-ops-config.
  - User is asking a question; intent has to be a project-shape change.
  - Intent is ambiguous; ask a clarifying question first.
writes_to_github: yes, but only via github-sync (label taxonomy changes, relabelling existing issues on user approval)
writes_to_filesystem: yes, with diff preview and explicit user approval
---

# adapt-system

Before acting, read the target project's `.claude/ops.config.json`. If the file is missing or invalid, halt and point at `bootstrap-ops-config`.

Reshapes a live installation when the project's context changes. Every change is produced as a unified diff first; nothing is written or pushed until the user approves.

## Inputs

- Current `ops.config.json`, validated against the schema.
- Current label set from GitHub (via `github-sync`).
- Current template, rule, and memory-seed state in the bundle.
- Free-form user intent string, e.g. `"we handle PHI now"` or `"drop TelemetryDeck; we're moving to PostHog"`.
- Optional structured flags (`--add-stack swift`, `--drop-area telemetry`).

## Outputs

- A unified diff across (potentially) every file listed in "Cascade targets" below.
- A label reconciliation plan (adds, renames, deprecations) presented alongside the diff.
- On user approval, writes the file changes and calls `github-sync` to apply the label plan.

## Flow

1. **Parse intent**: classify into one or more signals (`domain:*`, `compliance:*`, `stack:add:*`, `stack:drop:*`, `audience:*`, `dependency:add:*`, `dependency:drop:*`, `platform:*`, `cadence:*`). If ambiguous, ask a clarifying question before proceeding.
2. **Load state**: read `ops.config.json`, the bundle's current templates/rules/seeds, the current GitHub label set via `github-sync`.
3. **Propose cascade**: for each signal, determine which files and keys need to change. Record decisions, not edits yet.
4. **Dry-run diff**: materialise the full set of edits as a unified diff. Include:
   - `ops.config.json` key additions, updates, removals.
   - `labels.*` additions, renames, deprecations.
   - `templates/*.md` sections added or removed (e.g. add a "PHI impact" section to `issue-feature.md`).
   - New `rules/product-*.md` files (marked `portable: false` in frontmatter).
   - Memory-seed installs to the target project's memory (filtered by updated stack tags).
   - GitHub label taxonomy plan.
5. **Narrate**: for each change, emit a one-line reason tying it back to the original intent. No silent edits.
6. **Prompt user**: approve, edit, or reject. Edits can narrow scope ("skip the label changes, keep the config").
7. **Apply** (only on approval): write file changes, commit nothing (user owns commits), call `github-sync` for label plan.
8. **Record**: append an entry to `.install-manifest.json` with the signals, the diff summary, and the date.

## Cascade targets

| Signal | Affects |
| --- | --- |
| `compliance:*` | `ops.config.json -> compliance.*`, `labels.area` additions, new `rules/product-*.md`, template sections |
| `stack:add:*` / `stack:drop:*` | `ops.config.json -> stack.*`, memory seeds installed, `workflow.pr.tests_required` / `e2e_required_on` if relevant |
| `domain:*` | `labels.area` additions, `area_keywords` updates, optional `rules/product-*.md`, template sections |
| `audience:*` | `labels.area` additions (e.g. `area/enterprise`), `templates/release-readiness-checklist.md` sections (e.g. SLA) |
| `dependency:add:*` / `dependency:drop:*` | `area_keywords`, regression-handler lookup paths, memory-seed removals for dropped stacks |
| `platform:*` | `stack.platform`, memory seeds, branch patterns if relevant |
| `cadence:*` | `labels.intent`, release umbrella list (re-derived), `workflow.phase_term` |

## Idempotency

Running the same intent twice against the already-adapted state produces a no-op diff. The skill prints `"No changes proposed."` and exits.

## Contradiction handling

If an intent contradicts a prior adapt ("we dropped the legacy analytics SDK" after earlier adding it), the skill:

1. Produces a removal-diff.
2. Flags open GitHub issues tagged with the area label being removed and lists them for the user to reassign or close.
3. Does not delete the historical `.bootstrap-answers.json` entry; the audit trail stays intact.

## Failure modes

- **Intent ambiguous**: halt with a single clarifying question. Do not guess.
- **Diff would violate schema**: halt, show the invalid section, ask the user to refine the intent.
- **GitHub label plan fails mid-apply**: roll back file changes using the pre-write snapshot and surface the error; ask the user whether to retry or abandon.
- **User approves file diff but rejects label plan**: apply the file diff, print the rejected label plan for manual handling, exit cleanly.

## Cross-skill handoffs

- `github-sync`: to inspect and reconcile labels and to relabel existing issues when the taxonomy shifts.
- `install_memory_seeds.mjs`: to install or remove memory seeds when `stack.*` changes.
- Does not call `dev-loop`, `release-tracker`, `regression-handler`, `plan-keeper`.

## Project contract

- `project.name`, `project.repo` (for prefixing commit messages if the user asks for a commit).
- `github.dev_projects[]`, `github.release_projects[]`, `github.observed_repos[]` (when relabelling propagates to multiple targets).
- `labels.type`, `labels.area`, `labels.priority`, `labels.intent`, `labels.size`, `labels.automation`, `labels.state_modifiers`.
- `workflow.phase_term`, `workflow.pr.e2e_required_on`, `workflow.code_review.provider`.
- `paths.templates`, `paths.reports` (to know where artefacts live).
- `stack.language`, `stack.testing`, `stack.platform`.
- `area_keywords`.
- `compliance.regimes`, `compliance.data_classes`.
