---
name: regression-handler
description: When the user reports a bug, runs a deterministic lookup (referenced commit or file, area label on recent closed issues, title keyword match) across every GitHub target the config permits. Attaches a filled regression-report.md and proposes reopen, relink, or new-issue actions. User approves before any write.
trigger_on:
  - User reports a regression (a bug in previously-shipped or previously-closed functionality).
  - User pastes a stack trace, file path, or commit reference and asks what broke this.
  - /regression-handler invoked directly.
do_not_trigger_on:
  - New features that never worked (that is a bug but not a regression; use issue-bug template directly).
  - Questions that do not name specific behaviour ("something feels slow").
  - The bug issue the user referenced is already closed with a resolution comment, OR a candidate "best match" has near-equal scores across multiple recently-closed issues. Follow `rules/ambiguity-halt.md` (halt, surface the observation, ask); do not reopen, relabel, or file a new issue while the question is open.
writes_to_github: yes, via tracker-sync (reopen, comment with report, or create new linked issue), always behind user approval
writes_to_filesystem: writes the regression report to paths.reports
---

# regression-handler

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if missing or invalid.

Makes regression triage reproducible. Every proposed action is logged in the report, so the user can audit why a given remediation was chosen.

## Inputs

- A free-form regression report from the user (stack trace, screenshot, description, file path, commit SHA, anything relevant).
- Optional flags:
  - `--since <date|commit|version>` to bound the lookup window.
  - `--areas <a,b>` to restrict to specific area labels.
  - `--repo <owner/name>` to restrict to a single observed repo.

## Outputs

- A regression report filed under `{{ paths.reports }}/` (which resolves under `.development/shared/reports/` by default), rendered from `templates/regression-report.md`. Per `rules/llm-wiki.md`, this write goes through `@ctxr/skill-llm-wiki` in a **nested, scalable layout**: never as a flat date-prefixed sibling, and never with a hand-rolled versioned filename (no `.v1.md`, `-v2.md`, or any user-visible `.vN` scheme; history lives in the skill's private git). Regression reports are a dated topic: the wiki must be built in hosted mode with `dynamic_subdirs.template: "{yyyy}/{mm}/{dd}"` so leaves land at `.../reports/{yyyy}/{mm}/{dd}/<slug>.md`. Consult the skill's SKILL.md for the exact leaf path and frontmatter, and invoke its validate/fix operation after the write so the wiki's index picks up the new leaf. If the current reports wiki still has flat siblings, run `skill-llm-wiki fix` or `rebuild` to migrate the layout before writing.
- A proposal block with one or more of:
  - Reopen issue `#NNN` (if its close date is within a tunable window and the match is strong).
  - Create new bug issue linked to `#NNN` as the suspected origin.
  - Further investigation needed (no match strong enough).
- On approval, `tracker-sync` executes the chosen action.

## Lookup order

1. **Referenced commit or file**: if the user's input names a commit SHA or a file path, resolve it to touching issues and PRs via `gh api` on every configured target.
2. **Area label match via `area_keywords`**: tokenise the report, look up each token in `ops.config.json -> area_keywords`, accumulate matching area labels; search recently-closed issues carrying those labels across every target.
3. **Title keyword match**: pull the top 10 keywords from the report (stop-words removed), search issue titles across every target.

Each step produces candidates. The skill scores and ranks them; the top candidate is presented as the "Best match" in the report, ranked candidates as "Other candidates". The user confirms the match.

## Severity read

Severity is proposed from the interplay of:

- `labels.priority` conventions (e.g. `p0-blocker` if the report mentions data loss, crashes, or security).
- `compliance.data_classes` (anything touching PHI, payment, biometric lifts the severity floor).
- Number of users described or number of targets affected.

The skill never sets priority silently; it proposes and the user confirms.

## Actions the skill can propose

- **Reopen**: if the match is strong and close date is within the reopen window (default 14 days, configurable). Requires a target with write depth.
- **Create new bug**: the default when no strong match is within the window; links to the suspected origin issue as "regression of".
- **Further investigation**: when no match rises above the configured minimum score. The skill files the report anyway so the trail is preserved.

## Idempotency

Running `regression-handler` twice on the same input produces the same report and proposal. If the first run already created a new bug issue, the second run detects the existing one (via title fingerprint) and updates it rather than creating a duplicate.

## Failure modes

- **No GitHub targets with write depth**: skill runs the lookup, files the report, and exits with a "no actionable target" note. User handles manually.
- **gh rate-limit during lookup**: degrade to partial results, clearly marked in the report.
- **Ambiguous user input (e.g. "thing broke")**: ask one clarifying question. Do not guess.
- **Match score below the configured minimum across every target**: propose "further investigation" rather than guessing.

## Cross-skill handoffs

- `tracker-sync` for every read and for the approved write action.
- `plan-keeper` if the user wants to open a plan file for the investigation (optional).
- Does not call `dev-loop`, `release-tracker`, `adapt-system`, `bootstrap-ops-config`.

## Project contract

- `project.name`, `project.repo`.
- `trackers.dev.projects[]` (when `kind` is GitHub), `trackers.release.projects[]` (optional; absent when the project opted out of release umbrellas), `trackers.observed[]` (each with its own kind + coordinates): all scope the lookup.
- `labels.type` (picks `bug`), `labels.priority`, `labels.area`, `labels.automation` (applies `auto-regression` when present).
- `labels.state_modifiers` (to mark the report with blocked/deferred where relevant).
- `area_keywords` (primary lookup input).
- `paths.reports` (where the report lands), `paths.templates` (to render the report).
- `workflow.pr.e2e_required_on` (informs severity: regressions on e2e-gated areas weigh heavier).
- `compliance.data_classes`, `compliance.regimes` (severity floor).
