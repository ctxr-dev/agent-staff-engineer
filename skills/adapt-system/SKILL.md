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
  - The proposed cascading diff would touch a path the adapt-system skill never owns (`bundle-index.md`, `.gitignore`, any file in `.github/`, or any region of `CLAUDE.md` outside the managed block delimited by the `<!-- agent:block -->` markers). Follow `rules/ambiguity-halt.md` (halt, surface the observation, ask); do not apply the diff while the question is open.
  - Two different user intents in the same session cascade to contradictory labels or contradictory `ops.config.json` values. Follow `rules/ambiguity-halt.md` (halt, name the collision, ask which intent wins).
writes_to_github: yes, but only via tracker-sync (label taxonomy changes, relabelling existing issues on user approval)
writes_to_filesystem: yes, with diff preview and explicit user approval
---

# adapt-system

Before acting, read the target project's `.claude/ops.config.json`. If the file is missing or invalid, halt and point at `bootstrap-ops-config`.

Reshapes a live installation when the project's context changes. Every change is produced as a unified diff first; nothing is written or pushed until the user approves.

## Inputs

- Current `ops.config.json`, validated against the schema.
- Current label set from GitHub (via `tracker-sync`).
- Current template, rule, and memory-seed state in the bundle.
- Free-form user intent string, e.g. `"we handle PHI now"` or `"drop TelemetryDeck; we're moving to PostHog"`.
- Optional structured flags (`--add-stack swift`, `--drop-area telemetry`).

## Outputs

- A unified diff across (potentially) every file listed in "Cascade targets" below.
- A label reconciliation plan (adds, renames, deprecations) presented alongside the diff.
- On user approval, writes the file changes and calls `tracker-sync` to apply the label plan.

## Flow

1. **Parse intent**: classify into one or more signals (`domain:*`, `compliance:*`, `stack:add:*`, `stack:drop:*`, `audience:*`, `dependency:add:*`, `dependency:drop:*`, `platform:*`, `cadence:*`). If ambiguous, ask a clarifying question before proceeding.
2. **Load state**: read `ops.config.json`, the bundle's current templates/rules/seeds, the current tracker label / tag set via `tracker-sync`.
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
7. **Apply** (only on approval): write file changes, commit nothing (user owns commits), call `tracker-sync` for label plan.
8. **Record**: append an entry to the agent-scoped install manifest (`.claude/.<scoped-agent-slug>-install-manifest.json`) with the signals, the diff summary, and the date.

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
| `tracker:migrate:<from>:<to>` | `ops.config.json -> trackers.dev` (new kind), `trackers.observed[]` (old kind appended as read-only), optional `trackers.release` update, new `migration` sidecar block on the config |

## Tracker migration op

Triggered when the user's intent matches `"we're migrating from <X> to <Y>"` or `"we're moving dev tickets from <X> to <Y>"` (X, Y ∈ {github, jira, linear, gitlab}). The signal classifier emits `tracker:migrate:<X>:<Y>` and the cascade runs through four staged invocations the user confirms one at a time:

1. **Announce (diff stage)**: show the proposed diff that:
   - Replaces `trackers.dev` (or `trackers.release` if the user named the release tracker) with a new target of kind `<Y>`. The user supplies the `<Y>` coordinates (site/project, workspace/team, or host/project_path) in the same prompt.
   - Appends the outgoing `<X>` tracker to `trackers.observed[]` with `depth: "read-only"`. Read-only preserves the ability to reference historical issues via `tracker-sync` without ever writing back.
   - Adds a top-level `migration` sidecar: `{ from: "<X>", to: "<Y>", started_at: "<ISO date>", cutover_at: null, notes: "<intent text>" }`. The schema does not require `migration`; it is a cooperative record skills read during the transition.
2. **Dual-read (no-op mode)**: no diff; the skill prints guidance that both trackers are now authoritative within their scopes. `tracker-source-of-truth` formalises this. The agent emits cross-link comments of the form `[from <X>:<id>] now tracked as <Y>:<new-id>` on new items during this stage, so the provenance is on the record, not just in memory.
3. **Cutover**: flip `migration.cutover_at` to today's ISO date. From this point forward the agent ignores `<X>` writes (the observed entry stays so historical reads keep working). Re-emits the `tracker-source-of-truth` guidance to the session.
4. **Drop old** (optional, much later): remove the `<X>` entry from `trackers.observed[]` and delete the `migration` block. Run only when the team confirms no dangling references remain.

Each stage is a separate `adapt-system` invocation with a dry-run diff, user approval, and an entry in the install manifest. The whole flow is deliberately slow so the team controls every tracker mutation explicitly; silently switching trackers mid-sprint would orphan every in-flight issue.

Ambiguity halt (per `rules/ambiguity-halt.md`): if the proposed diff would touch any live PR / MR while `cutover_at === null`, or the `from` tracker has open issues the agent can't classify as "moving to <Y>" vs "staying on <X>", halt and surface the list of in-flight items before any mutation.

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

- `tracker-sync`: to inspect and reconcile labels and to relabel existing issues when the taxonomy shifts.
- `install_memory_seeds.mjs`: to install or remove memory seeds when `stack.*` changes.
- Does not call `dev-loop`, `release-tracker`, `regression-handler`, `plan-keeper`.

## Project contract

- `project.name`, `project.repo` (for prefixing commit messages if the user asks for a commit).
- `trackers.dev`, `trackers.release`, `trackers.observed[]` (when relabelling propagates to multiple targets).
- `migration` (optional sidecar) when a tracker migration is in flight; drives the cross-link comment format and the dual-read window.
- `labels.type`, `labels.area`, `labels.priority`, `labels.intent`, `labels.size`, `labels.automation`, `labels.state_modifiers`.
- `workflow.phase_term`, `workflow.pr.e2e_required_on`, `workflow.code_review.provider`.
- `paths.templates`, `paths.reports` (to know where artefacts live).
- `stack.language`, `stack.testing`, `stack.platform`.
- `area_keywords`.
- `compliance.regimes`, `compliance.data_classes`.
