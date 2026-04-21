---
name: pr-iteration
description: Drives a PR from "just opened" to a green terminal state by requesting an external reviewer, polling for CI and review, triaging threads, fixing, resolving, and iterating until all three exit conditions hold. Never merges. The canonical PR lifecycle codification of the issue-development-automated-loop runbook.
trigger_on:
  - dev-loop hands off after opening a PR (and workflow.external_review.enabled is true).
  - User explicitly runs /pr-iteration <pr-number> on an existing PR.
do_not_trigger_on:
  - workflow.external_review.enabled is false (dev-loop halts at In review instead).
  - workflow.external_review.provider is "none", i.e. the dispatcher resolves kind to "none" as an explicit opt-out. Same effect as enabled:false; halt cleanly at In review, do NOT surface a NotSupportedError (which is reserved for unsupported tracker kinds).
  - PRs on trackers where the tracker dispatcher (`scripts/lib/trackers/dispatcher.mjs#pickReviewProvider`) returns the stub `.review` namespace for a tracker kind that isn't "none" (Jira / Linear / GitLab today). Surface the `NotSupportedError` message and halt.
  - Without a valid ops.config.json (halt and point at bootstrap-ops-config).
  - The PR HEAD advanced between rounds by a commit this loop did not author, OR an unresolved review thread's author is neither a configured bot (`workflow.external_review.bots`) nor the project owner AND the comment contradicts a commit of the loop. Follow `rules/ambiguity-halt.md` (halt, surface the observation, ask); do not push, resolve threads, or re-request reviewers while the question is open.
writes_to_github: yes, via tracker-sync for status updates and via tracker-specific providers (GraphQL requestReviews / resolveReviewThread for GitHub) for review mutations
writes_to_filesystem: yes, code edits per round plus a per-round pr-iteration report under paths.reports (written via @ctxr/skill-llm-wiki, per rules/llm-wiki.md)
---

# pr-iteration

Before acting, read `.claude/ops.config.json` and `rules/pr-iteration.md`. Refuse to run if either is missing. This skill is the orchestration entry point; the rule is the contract; the runbook at `skills/pr-iteration/runbook.md` (co-located in the bundle) is the canonical how-to with GraphQL recipes.

Hard rule baked in: **pr-iteration never merges a PR.** Merge is a human gate. Every code path ends at one of: (a) all three exit conditions hold and the skill reports + stops; (b) the poll timeout fires and the skill surfaces state + stops; (c) the provider declines with `NotSupportedError` and the skill halts cleanly at "In review".

## Inputs

- PR number on the tracker that owns dev issues (`trackers.dev.kind`).
- Optional workspace member. For multi-repo projects (`workspace.members[]` present), the skill inherits the member name from the originating `dev-loop` invocation, or resolves it via `resolveMemberFromPath(cfg, filePath)` on the PR's changed files. The review provider is then picked via `pickTrackerForMember(cfg, memberName, "dev").tracker.review`. Single-repo projects omit `memberName` and route through `trackers.dev` as before.
- Optional override of `workflow.external_review.*` fields for this invocation (rare).

## Outputs

- One commit per round on the feature branch, `fix(review-round-N): ...` with a per-thread bullet list.
- External reviewer request on each round's new HEAD.
- Resolved review threads for every addressed finding.
- A `pr-iteration-report.md` artefact per round, written into `.development/shared/reports/` via `@ctxr/skill-llm-wiki` (per `rules/llm-wiki.md`).
- A final "all exit conditions green" report to the human; the PR stays at "In review" awaiting merge.

## State machine

```text
[dev-loop hands off; PR at "In review"]
      |
      v
[assert local review GO on HEAD] -- NOT GO --> [fix + re-run local review]
      |
      v
[push feature branch]
      |
      v
[tracker.review.requestReview on HEAD]
      |
      v
[check once via tracker.review.pollForReview]
      |
      +-- CI terminal AND (unresolved>0 OR reviewOnHead)
      |     --> [fetch threads, triage, fix + commit + push + resolve + re-request]
      |     --> persist state, ScheduleWakeup --> (next tick re-enters here)
      +-- CI PENDING, no threads, no review on HEAD
      |     --> persist state, ScheduleWakeup --> (next tick re-enters here)
      +-- .stopped sidecar present --> [exit: user cancelled]
      +-- consecutive wakes >= max --> [write .paused, exit: safety cap]
      +-- NotSupportedError from tracker.review.* --> [clean halt at In review]
      |
      v
[all three exit conditions hold on current HEAD]
      |
      v
[write final report; delete state file; stop]   *** HUMAN GATE 1: merge PR ***
```

The two human gates from `rules/pr-workflow.md` are preserved: merge and dev-issue Done.

## Autonomous mode (default)

When `workflow.external_review.autonomous.enabled` is `true` (the default), step 4 of the state machine uses `ScheduleWakeup` instead of an in-session poll. Each wakeup is one tick: poll once, evaluate exit conditions, act or reschedule. This survives session close, IDE restart, network hiccups, and context compaction.

**State persistence:** One JSON file per active PR under `.development/local/pr-iteration/<owner>__<repo>__<number>.json`, validated against `schemas/pr-iteration-state.schema.json` on every read. The `.development/local/` subtree is gitignored by convention, so state never leaks into commits.

**Interval:** Default 270 seconds (stays inside the 5-minute Anthropic prompt-cache window, avoiding cache-miss cost). Honours a free-form user override ("every 10 min") and the `autonomous.default_interval_seconds` config key.

**Resume on session start:** On every agent invocation, `rules/agent-boot.md` scans the state directory and surfaces a "PR #N has a pending iteration loop" prompt per pending PR. The user answers resume / defer / stop. Never auto-resumes silently.

**Cancel / pause:**

1. **Normal completion:** All three exit conditions hold. The tick deletes the state file and writes the final report. No further wakeups.
2. **User cancels:** Agent writes a `.stopped` sidecar. The next wakeup reads it and exits without rescheduling.
3. **Safety cap:** After `max_consecutive_wakes` (default 96, roughly 7.2 hours) without forward progress, the tick writes a `.paused` sidecar and stops. Human deletes the file to resume.

**Legacy mode:** Set `workflow.external_review.autonomous.enabled` to `false` to restore the pre-PR-14 in-session poll at `poll_interval_seconds` (default 30s), capped by `poll_timeout_seconds` (default 1200s). The full poll loop runs in the active turn, blocking the user.

## Provider dispatch

The review provider is the `.review` namespace of the Tracker resolved via `scripts/lib/trackers/dispatcher.mjs` (`pickReviewProvider(cfg)`) at the start of each round, so a mid-iteration change to `trackers.dev.kind` (rare, but possible under `adapt-system` migration) picks up the new kind cleanly. Providers:

- **GitHub** (`scripts/lib/trackers/github.mjs`): full impl. Uses `gh api graphql` via `scripts/lib/ghExec.mjs`' `ghGraphqlQuery` / `ghGraphqlMutation` helpers. The skill resolves reviewer LOGINS (from `workflow.external_review.bots.github`, e.g. `copilot-pull-request-reviewer`) into GraphQL node IDs via the recipe in `rules/pr-iteration.md`, caches both the PR's node ID and the bot node IDs in the in-memory iteration state, and passes the resolved node IDs to the provider as `ctx.botIds` on every call. The provider itself stays login-agnostic.
- **Stub** (`scripts/lib/trackers/stub.mjs`): every op throws `NotSupportedError`. Returned for Jira, Linear, GitLab until their real tracker impls land in follow-up PRs.

## Exit conditions (re-emphasised)

All three must hold on the **current HEAD** (not an earlier one). These mirror `rules/pr-iteration.md` exactly; on drift the rule wins.

1. `rules/review-loop.md` returns **GO** when re-run on HEAD.
2. **Zero unresolved threads** on HEAD, AND the **most recent** external review is on HEAD's SHA.
3. CI `statusCheckRollup.state === "SUCCESS"` on HEAD's last commit.

A review "on HEAD" with zero comments (the reviewer looked and found nothing) counts toward condition 2. The runbook's rationale section documents this.

## Thread triage heuristics

Each round fetches threads, classifies every unresolved one as one of three buckets (detailed detection logic in the runbook):

- **Stale** (re-emitted on a superseded SHA, or same `path:line` with no intervening code change): resolve without a code change. Auto-resolve after `workflow.external_review.auto_resolve_stale_after_commits` recurrences (default 1).
- **Actionable**: fix in code. For behavioural issues (security, TOCTOU, exit code, parsing), add a regression test that locks the fix in. Run the affected test suite locally before pushing.
- **Suggestion-only / style**: take the change or reply pushing back with reasoning.

## Project contract

This skill writes into `.development/shared/reports/**` and MUST follow `rules/llm-wiki.md`: every doc it persists under `.development/{shared,local,cache}/**` is placed through `@ctxr/skill-llm-wiki` (the agent reads the canonical `skill-llm-wiki` SKILL.md for format + placement, then writes direct into the target topic wiki).

`ops.config.json` keys read:

- `trackers.dev.kind` to pick the review provider (github / jira / linear / gitlab).
- `workflow.external_review.enabled` (gate the whole loop).
- `workflow.external_review.provider` (`auto` / `github` / `none`).
- `workflow.external_review.bots` (per-kind reviewer LOGINS; for GitHub, the skill resolves login → GraphQL node ID at runtime and caches the derived IDs in the in-memory iteration state).
- `workflow.external_review.poll_interval_seconds` (legacy mode only).
- `workflow.external_review.poll_timeout_seconds` (legacy mode only).
- `workflow.external_review.auto_resolve_stale_after_commits`.
- `workflow.external_review.autonomous.enabled` (gate: wakeup-driven vs. legacy poll).
- `workflow.external_review.autonomous.default_interval_seconds` (wakeup interval).
- `workflow.external_review.autonomous.max_consecutive_wakes` (safety cap).
- `workflow.code_review.*` (the pre-push local review, re-checked every round).
- `paths.reports` (report artefact target, routed through the llm-wiki per rules/llm-wiki.md).

## Reports

Per-round artefact structure: see `templates/pr-iteration-report.md`. Minimum fields:

- round number; previous HEAD; new HEAD
- `requestReview` outcome (reviewer logins echoed back)
- poll result (`ciState`, `unresolvedCount`, `reviewOnHead`, elapsed time)
- threads resolved (id + one-line justification), threads flagged stale (id + fingerprint), threads deferred (id + reason)
- commits in the round (sha + one-liner)
- exit-condition status at end of round

## Error surfaces

- `NotSupportedError` from provider: clean halt. Message names the kind and the op.
- `GhGraphqlError`: surface the error body (GitHub often returns useful error text) and retry once. Fail the round if it recurs.
- Poll timeout: dump the last poll result, stop. Do not commit any changes.
- Local review still NO-GO after a round of fixes: stop. The user decides whether to push back on the local reviewer or fix further.

## Related

- `rules/pr-iteration.md`: binding contract.
- `rules/pr-workflow.md`: full PR state machine in which this skill plugs after "In review".
- `rules/agent-boot.md`: session-start resume prompt for pending iteration loops.
- `skills/dev-loop/SKILL.md`: hands off to this skill after opening the PR.
- `scripts/lib/trackers/*.mjs`: the Tracker implementations (GitHub real; Jira/Linear/GitLab stubbed).
- `scripts/lib/pr-iteration/state.mjs`: persistent state read/write/list.
- `scripts/lib/pr-iteration/tick.mjs`: one-shot tick (poll + exit-condition check).
- `scripts/lib/pr-iteration/reschedule.mjs`: interval computation + wakeup prompt builder.
- `skills/pr-iteration/runbook.md`: canonical how-to with full GraphQL recipes.
