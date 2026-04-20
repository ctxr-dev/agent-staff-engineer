---
name: release-tracker
description: Computes Release umbrella status from linked dev issues. Auto-moves each umbrella through Backlog -> In progress -> Done and maintains the "Linked Dev Issues" counter and blocker list on the umbrella body. Never auto-promotes a dev issue to Done.
trigger_on:
  - Any dev-issue status change on a dev project whose `depth` is `full` and that is linked to a release umbrella.
  - Issue linked to or unlinked from a release umbrella.
  - User explicitly asks for a release status recompute.
  - After adapt-system changes the intent label taxonomy (new or removed intent values).
do_not_trigger_on:
  - Release projects whose `depth` is `read-only`.
  - Projects with zero release_projects configured.
  - The project opted out of release umbrellas entirely (`trackers.release` absent from `.claude/ops.config.json`). The skill halts silently, neither reporting nor writing; any caller that invoked it explicitly receives a no-op result.
  - The recompute would flip an umbrella to Done while one or more linked dev issues are reopened OR their relation to the umbrella was broken between fetch and write. Follow `rules/ambiguity-halt.md` (halt, surface the mismatch and the specific issue numbers, ask whether to exclude, re-link, or wait); do not flip the umbrella status or mutate the body while the question is open.
writes_to_github: yes, via tracker-sync, only on release umbrellas
writes_to_filesystem: no
---

# release-tracker

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if missing or invalid.

Owns release umbrella state. Never touches dev issues. Never moves a dev issue to Done.

## Inputs

- A release umbrella issue reference, or `--all` to recompute every umbrella in every `release_project`.
- A specific dev-issue change event (from `tracker-sync` or a user request).

## Outputs

- Updated `Status` field on the umbrella (one of the project's status_values).
- Updated umbrella body blocks:
  - `<!-- agent:block linked_dev_issues -->` re-rendered with current list and per-issue status.
  - `<!-- agent:block status_summary -->` one-line summary (e.g. `2 Done / 1 In review / 3 In progress / 4 Ready / 6 Backlog / 1 Blocked`).
  - `<!-- agent:block blocker_list -->` the set of linked issues carrying any `labels.state_modifiers` value.
- Updated umbrella fields:
  - `Linked Dev Issues` (numeric count).
  - `Scope Tag` preserved.

## Computation

For each umbrella:

```text
linked = issues linked to the umbrella via the release project's "Linked Dev Issues" relation
         or carrying the umbrella's intent label

statuses = { backlog, ready, in_progress, in_review, done } counts across linked

if every issue in linked is Done:
    umbrella.Status = status_values.done
elif any issue.status in { ready, in_progress, in_review }:
    umbrella.Status = status_values.in_progress
else:
    umbrella.Status = status_values.backlog

blocker_count = count of linked issues with any label in state_modifiers
```

The "umbrella is Done" condition is strict: every linked issue must be in the Done status. A human set each of them Done, so the umbrella Done is transitively a human decision.

## Idempotency

A recompute against the same underlying state is a no-op write (the skill compares before-and-after and skips if identical).

## Guardrails

- Refuses to move any dev issue. The skill's surface has no "update dev status" entry point.
- Refuses to touch umbrellas in a `depth: read-only` release_project.
- `depth: umbrella-only` is the natural fit for release projects; the skill works correctly under `full` or `umbrella-only`.

## Failure modes

- **Umbrella missing the required block placeholders**: rewrite the body from `templates/issue-release.md`, preserving fields; warn.
- **Linked relation broken (stale reference)**: log the stale link, continue with remaining; surface at the end.
- **tracker-sync rate-limited**: back off per `tracker-sync`'s retry policy.

## Cross-skill handoffs

- Triggered by `tracker-sync` (via an event hook or explicit call) when linked issues change.
- Called by `adapt-system` after a change to `labels.intent` values (adds, renames, or removals), to recreate or reconcile umbrellas.
- Consumes `tracker-sync` for every read and write.

## Release umbrella creation

Umbrellas are created by `tracker-sync.create_release_umbrella` when a new `labels.intent` value exists without a corresponding umbrella on any configured `release_project`. Title template from `workflow.release.umbrella_title`. `release-tracker` verifies one umbrella exists per intent value and asks `tracker-sync` to create missing ones on approval.

## Project contract

- `project.name` (for summary printing).
- `github.release_projects[]` (owner, number, role, depth, status_field, status_values, fields).
- `github.dev_projects[]` (only to read linked-issue statuses).
- `labels.intent` (one umbrella per value).
- `labels.state_modifiers` (to compute blocker count).
- `workflow.release.umbrella_title`.
- `workflow.phase_term` (for the pretty-printed intent label in the umbrella title).
- `paths.templates` (to re-render the umbrella body if placeholders are missing).
