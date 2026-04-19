---
name: tracker-sync
description: The only skill that writes to the configured issue/PR trackers. Idempotent read and write for issues, labels, project fields, status moves, comments, and release umbrellas across every target declared in ops.config.json, respecting each target's depth. Dispatches to GitHub, Jira, Linear, or GitLab via scripts/lib/trackers/dispatcher.mjs. Hosts the rollout-to-issues sub-operation used by projects converting legacy planning MDs.
trigger_on:
  - Any skill that needs to read or mutate tracker state invokes tracker-sync.
  - Explicit user requests like "reconcile labels" or "convert rollout.md to issues".
do_not_trigger_on:
  - Read-only questions Claude can answer from local context alone.
  - Targets configured as read-only in ops.config.json, for any write path.
  - The requested mutation would run against an item whose current server-side state differs from the caller's precondition (stale ETag / version token, status-field value no longer in the configured `status_values`, item deleted between fetch and write). Follow `rules/ambiguity-halt.md` (halt, surface the divergence, ask the caller to re-read and re-decide); do not silently retry.
  - The tracker kind is one of jira, linear, gitlab and the requested op is not yet implemented. Surface the `NotSupportedError` tagged with kind+namespace+op and halt cleanly.
writes_to_github: yes for github targets, on approval or when called programmatically by another skill under that skill's own approval flow
writes_to_filesystem: no
---

# tracker-sync

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if it is missing or invalid; tell the caller to run `bootstrap-ops-config` or `adapt-system` first.

Centralises every tracker API call. Other skills describe what they want; `tracker-sync` owns how it hits the API of the configured kind, how it respects per-target depth, and how it stays idempotent. Concrete backends live in `scripts/lib/trackers/`:

- **GitHub**: partial impl via `gh` CLI + GraphQL. The `review.*` namespace is fully implemented (backs `skills/pr-iteration`); `issues.*`, `projects.*`, and `labels.*` are currently stubbed and throw `NotSupportedError` until ported from the pre-trackers gh-only path. Follow-up PRs wire those namespaces onto `scripts/lib/trackers/github.mjs`.
- **Jira / Linear / GitLab**: every namespace stubbed today; every op throws `NotSupportedError`. Callers catch and halt cleanly. Real backends land in follow-up PRs.

## Inputs

- Role (`dev` or `release`) plus an optional workspace member name when `workspace.members[]` is configured. The skill resolves these to a tracker target via `scripts/lib/trackers/dispatcher.mjs#pickTracker`.
- Operation name (enum, see "Operations" below).
- Operation-specific payload (issue title, label list, field-value map, thread ID, etc.).
- Approval mode (`dry-run` default, `--apply` to write).

## Outputs

- The operation result (created issue ID, reconciliation diff, fetched state).
- A structured log line per call: operation, role, tracker kind, target, mode, status, latency.

## Operations

The method list is grouped by namespace on the Tracker interface (see `scripts/lib/trackers/tracker.mjs` for the canonical method names). Each entry is tagged with its current implementation status on this PR: **implemented on github** means the github backend has working code; **stubbed on every backend** means every Tracker throws `NotSupportedError` today and the operation is part of the contract, pending a port of the pre-trackers gh-only code path. Real backends for jira / linear / gitlab land in follow-up PRs.

- **`issues.createIssue`** (stubbed on every backend): render the right template from `templates/` against caller-supplied placeholders, apply labels, link the release umbrella.
- **`issues.updateIssueStatus`** (stubbed on every backend): move an issue to a named status, never to Done. Status vocabulary comes from `trackers.<role>.status_values` (GitHub) or the per-kind equivalent (Jira workflow state, Linear workflow state, GitLab scoped label).
- **`issues.comment`** (stubbed on every backend): post a comment on an issue (e.g. a filled regression report).
- **`issues.relabelIssue`** / **`labels.relabelBulk`** (stubbed on every backend): apply a label taxonomy plan from `adapt-system`, including renames via add-new plus remove-old.
- **`issues.getIssue`** / **`issues.listIssues`** (stubbed on every backend): read-only lookups, respecting depth.
- **`labels.reconcileLabels`** (stubbed on every backend): compare the target's labels to `ops.config.json -> labels.*`; produce an add/edit/deprecate plan; apply on approval.
- **`projects.reconcileProjectFields`** (stubbed on every backend): ensure every field declared in the github tracker's `projects[].fields` exists on the right Project v2 board; add missing fields. The Project v2 concept is GitHub-specific; other tracker kinds will either surface `NotSupportedError` or map to a native equivalent when they ship.
- **`projects.listProjectItems`** (stubbed on every backend): read-only snapshot of project items with their fields.
- **`projects.updateProjectField`** (stubbed on every backend): single-field update on a project item.
- **`review.requestReview`** / **`review.pollForReview`** / **`review.fetchUnresolvedThreads`** / **`review.resolveThread`** / **`review.ciStateOnHead`** (implemented on github; stubbed on jira/linear/gitlab): the post-push review iteration surface used by `skills/pr-iteration`. GitHub implements all five via GraphQL. This is the only namespace with a real github implementation on this PR; issues / projects / labels will be ported in follow-up work.
- **`create_release_umbrella`** (sub-op, not on the Tracker surface yet; stubbed): create a Release umbrella issue (one per `labels.intent` value) using `templates/issue-release.md`. Will call `issues.createIssue` under the hood once that namespace is ported.
- **`convert_rollout_to_issues`** (one-time sub-op; stubbed): parse a legacy `rollout.md` into issues. Interactive; shows a batch preview of the first N and asks for approval before bulk-creating.
- **`open_pr`** (sub-op; stubbed on every backend): open a PR with body from `templates/pr.md`, linking the dev issue with `workflow.pr.link_issue_with`. Does not merge. On non-github trackers, the equivalent (merge request on GitLab, branch review on others) surfaces `NotSupportedError` until ported.

Every stubbed op throws `NotSupportedError` tagged with `{ kind, namespace, op }` so callers can surface a pointed "not implemented" message and halt cleanly.

## Depth enforcement

Every write is gated by the target entry's `depth`:

| Depth | Allowed writes |
| --- | --- |
| `full` | all |
| `umbrella-only` | only on items matching `type/release` or on Release umbrellas |
| `assigned-to-principals` | only on items assigned to anyone in `project.principals.*` |
| `labeled:<label>` | only on items carrying the given label |
| `issues-only` | issues yes, PRs / merge requests no |
| `read-only` | no writes at all |

Violations cause the call to halt with a clear refusal message, not a silent success.

## Idempotency

- `labels.reconcileLabels` adds missing labels, updates mismatched colors or descriptions, never duplicates.
- `projects.reconcileProjectFields` skips fields that already match.
- `issues.createIssue` de-duplicates by title + label fingerprint; calling it twice with the same payload returns the existing issue rather than creating a duplicate.
- `issues.updateIssueStatus` is a no-op when the issue is already in the requested status.

## Failure modes

- **Tracker CLI not authed or missing scopes** (gh / jira-cli / glab / Linear token): print the missing scope or token name and halt.
- **Rate-limited**: retry with exponential backoff (3 attempts). If still rate-limited, surface and ask whether to wait or abort.
- **Validation error from tracker API**: print the response body, map it to the operation step that failed, ask the user.
- **Network failure**: one retry, then surface.
- **`NotSupportedError`** (op not implemented for this tracker kind): surface the tagged error ({kind, namespace, op}) and halt cleanly. Do not silently fall back.

## Cross-skill handoffs

- NOT called by `bootstrap-ops-config`: this skill refuses to run without a valid `ops.config.json`, and bootstrap-ops-config produces that config in the first place. Bootstrap does its own detection through direct git / gh / env probes (see `scripts/bootstrap.mjs`) and never goes through `tracker-sync`.
- Called by `adapt-system` for label reconciliation and relabelling once a config exists.
- Called by `dev-loop` for `issues.createIssue` (rare), `issues.updateIssueStatus`, `review.requestReview`, `open_pr`, `issues.comment`.
- Called by `release-tracker` for `issues.updateIssueStatus` on Release umbrellas and `projects.listProjectItems`.
- Called by `regression-handler` for lookups and `issues.comment`.
- Called by `plan-keeper` only for read-only status confirmation.
- Called by `pr-iteration` for every `review.*` method.

## Project contract

- `project.repo`, `project.default_branch`, `project.principals.push_allowed`, `project.principals.reviewers_default`.
- `trackers.dev` and `trackers.release` (discriminated-union tracker targets; see `schemas/ops.config.schema.json#/definitions/trackerTarget`). Per-kind fields:
  - `github`: `owner`, `repo`, `auth_login`, `depth`, `projects[]` (each with `owner`, `number`, `depth`, `status_field`, `status_values`, `fields`, `label_scope`).
  - `jira`: `site`, `project`, `depth`, `status_values`, `labels_field`.
  - `linear`: `workspace`, `team`, `depth`, `status_values`.
  - `gitlab`: `host`, `project_path`, `depth`, `status_values`.
- `trackers.observed[]` (read-only tracker targets for cross-tracker lookups).
- `workspace.members[].trackers` (optional, for multi-repo workspaces; each member carries its own dev/release binding).
- `labels.type`, `labels.area`, `labels.priority`, `labels.intent`, `labels.size`, `labels.automation`, `labels.state_modifiers`.
- `workflow.pr.title`, `workflow.pr.body_template`, `workflow.pr.link_issue_with`, `workflow.pr.request_reviewers`.
- `workflow.release.umbrella_title`.
- `paths.templates` (to locate template files for rendering).
