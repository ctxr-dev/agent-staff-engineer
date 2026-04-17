---
name: github-sync
description: The only skill that writes to GitHub. Idempotent read and write for issues, labels, project fields, iterations, milestones, and project items across every target declared in ops.config.json, respecting each target's depth. Hosts the rollout-to-issues sub-operation used by projects converting legacy planning MDs.
trigger_on:
  - Any skill that needs to read or mutate GitHub state invokes github-sync.
  - Explicit user requests like "reconcile labels" or "convert rollout.md to issues".
do_not_trigger_on:
  - Read-only questions Claude can answer from local context alone.
  - Targets configured as read-only in ops.config.json, for any write path.
writes_to_github: yes, on approval or when called programmatically by another skill under that skill's own approval flow
writes_to_filesystem: no
---

# github-sync

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if it is missing or invalid; tell the caller to run `bootstrap-ops-config` or `adapt-system` first.

Centralises every gh call. Other skills describe what they want; `github-sync` owns how it hits the API, how it respects per-target depth, and how it stays idempotent.

## Inputs

- Operation name (enum, see "Operations" below).
- Target selector (`dev_project`, `release_project`, `observed_repo`, or `all`), plus the specific target entry from `ops.config.json`.
- Operation-specific payload (issue title, label list, field-value map, etc.).
- Approval mode (`dry-run` default, `--apply` to write).

## Outputs

- The operation result (created issue ID, reconciliation diff, fetched state).
- A structured log line per call: operation, target, mode, status, latency.

## Operations

- **`reconcile_labels`**: compare the target repo's labels to `ops.config.json -> labels.*`; produce an add/edit/deprecate plan; apply on approval.
- **`reconcile_project_fields`**: ensure every field declared in `github.dev_projects[].fields` and `github.release_projects[].fields` exists on the right project; add missing fields.
- **`create_issue`**: render the right template from `templates/` against caller-supplied placeholders, apply labels, assign reviewers, link Release umbrella.
- **`update_issue_status`**: move an issue to a named status on its project, never to Done.
- **`list_project_items`**: read-only snapshot of dev-project items with their fields.
- **`relabel_issues`**: apply a label taxonomy plan from `adapt-system`, including renames via add-new plus remove-old.
- **`create_release_umbrella`**: create a Release umbrella issue (one per `labels.intent` value) using `templates/issue-release.md`.
- **`convert_rollout_to_issues`**: one-time-per-project sub-op that parses a legacy `rollout.md` into issues. Interactive; shows a batch preview of the first N and asks for approval before bulk-creating.
- **`comment`**: post a comment on an issue (e.g. a filled regression report).
- **`request_review`**: request reviewers on a PR per `project.principals.reviewers_default`.
- **`open_pr`**: open a PR with body from `templates/pr.md`, linking the dev issue with `workflow.pr.link_issue_with`. Does not merge.

## Depth enforcement

Every write is gated by the target entry's `depth`:

| Depth | Allowed writes |
| --- | --- |
| `full` | all |
| `umbrella-only` | only on items matching `type/release` or on Release umbrellas |
| `assigned-to-principals` | only on items assigned to anyone in `project.principals.*` |
| `labeled:<label>` | only on items carrying the given label |
| `issues-only` | issues yes, PRs no |
| `read-only` | no writes at all |

Violations cause the call to halt with a clear refusal message, not a silent success.

## Idempotency

- `reconcile_labels` adds missing labels, updates mismatched colors or descriptions, never duplicates.
- `reconcile_project_fields` skips fields that already match.
- `create_issue` de-duplicates by title + label fingerprint; calling it twice with the same payload returns the existing issue rather than creating a duplicate.
- `update_issue_status` is a no-op when the issue is already in the requested status.

## Failure modes

- **gh not authed or missing scopes**: print the missing scope list and halt.
- **Rate-limited**: retry with exponential backoff (3 attempts). If still rate-limited, surface and ask whether to wait or abort.
- **Validation error from gh (e.g. invalid field)**: print the gh response body, map it to the operation step that failed, ask the user.
- **Network failure**: one retry, then surface.

## Cross-skill handoffs

- Called by `bootstrap-ops-config` only for read operations during detection.
- Called by `adapt-system` for label reconciliation and relabelling.
- Called by `dev-loop` for `create_issue` (rare), `update_issue_status`, `request_review`, `open_pr`, `comment`.
- Called by `release-tracker` for `update_issue_status` on Release umbrellas and `list_project_items`.
- Called by `regression-handler` for lookups and `comment`.
- Called by `plan-keeper` only for read-only status confirmation.

## Project contract

- `project.repo`, `project.default_branch`, `project.principals.push_allowed`, `project.principals.reviewers_default`.
- `github.auth_login`, `github.dev_projects[]` (owner, number, role, depth, status_field, status_values, fields, label_scope), `github.release_projects[]`, `github.observed_repos[]`.
- `labels.type`, `labels.area`, `labels.priority`, `labels.intent`, `labels.size`, `labels.automation`, `labels.state_modifiers`.
- `workflow.pr.title`, `workflow.pr.body_template`, `workflow.pr.link_issue_with`, `workflow.pr.request_reviewers`.
- `workflow.release.umbrella_title`.
- `paths.templates` (to locate template files for rendering).
