---
name: pr-iteration
description: Drives a PR from "just opened" to a green terminal state by requesting an external reviewer, polling for CI and review, triaging threads, fixing, resolving, and iterating until all three exit conditions hold. Never merges. The canonical PR lifecycle codification of the issue-development-automated-loop runbook.
trigger_on:
  - dev-loop hands off after opening a PR (and workflow.external_review.enabled is true).
  - User explicitly runs /pr-iteration <pr-number> on an existing PR.
do_not_trigger_on:
  - workflow.external_review.enabled is false (dev-loop halts at In review instead).
  - PRs on trackers where the ReviewProvider dispatcher returns the stub. Surface the `NotSupportedError` message and halt.
  - Without a valid ops.config.json (halt and point at bootstrap-ops-config).
writes_to_github: yes, via github-sync for status updates and via tracker-specific providers (GraphQL requestReviews / resolveReviewThread for GitHub) for review mutations
writes_to_filesystem: yes, code edits per round plus a per-round pr-iteration report under paths.reports (written via @ctxr/skill-llm-wiki, per rules/llm-wiki.md)
---

# pr-iteration

Before acting, read `.claude/ops.config.json` and `rules/pr-iteration.md`. Refuse to run if either is missing. This skill is the orchestration entry point; the rule is the contract; the runbook at `.development/shared/runbooks/pr-iteration-runbook.md` is the canonical how-to with GraphQL recipes.

Hard rule baked in: **pr-iteration never merges a PR.** Merge is a human gate. Every code path ends at one of: (a) all three exit conditions hold and the skill reports + stops; (b) the poll timeout fires and the skill surfaces state + stops; (c) the provider declines with `NotSupportedError` and the skill halts cleanly at "In review".

## Inputs

- PR number on the tracker that owns dev issues (`trackers.dev.kind`).
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
[ReviewProvider.requestReview on HEAD]
      |
      v
[poll every poll_interval_seconds]
      |
      +-- CI terminal AND (unresolved>0 OR reviewOnHead) --> [fetch threads, triage, fix + commit + push + resolve + re-request] --> back to poll
      +-- poll_timeout_seconds exceeded --> [surface state, stop]
      +-- provider.NotSupportedError --> [clean halt at In review]
      |
      v
[all three exit conditions hold on current HEAD]
      |
      v
[write final report; stop]          *** HUMAN GATE 1: merge PR ***
```

The two human gates from `rules/pr-workflow.md` are preserved: merge and dev-issue Done.

## Provider dispatch

The ReviewProvider is resolved via `scripts/lib/review/dispatcher.mjs` at the start of each round, so a mid-iteration change to `trackers.dev.kind` (rare, but possible under `adapt-system` migration) picks up the new kind cleanly. Providers:

- **GitHub** (`scripts/lib/review/github.mjs`): full impl. Uses `gh api graphql` via `scripts/lib/ghExec.mjs`' `ghGraphqlQuery` / `ghGraphqlMutation` helpers. Caches the PR's GraphQL node ID and the Copilot bot node ID in the in-memory iteration state so they're captured once per PR rather than per round.
- **Stub** (`scripts/lib/review/stub.mjs`): every op throws `NotSupportedError`. Returned for Jira, Linear, GitLab until PR 3's multi-tracker refactor wires real impls.

## Exit conditions (re-emphasised)

All three must hold on the **current HEAD** (not an earlier one):

1. `rules/review-loop.md` returns **GO** when re-run on HEAD.
2. **Zero unresolved threads** on HEAD, AND at least one external review is on HEAD's SHA.
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

- `trackers.dev.kind` (PR 3+) or legacy top-level `github:` block (pre-PR-3) to pick the ReviewProvider.
- `workflow.external_review.enabled` (gate the whole loop).
- `workflow.external_review.provider` (`auto` / `github` / `none`).
- `workflow.external_review.bots` (per-kind reviewer identifiers; GitHub node IDs).
- `workflow.external_review.poll_interval_seconds`.
- `workflow.external_review.poll_timeout_seconds`.
- `workflow.external_review.auto_resolve_stale_after_commits`.
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
- `skills/dev-loop/SKILL.md`: hands off to this skill after opening the PR.
- `scripts/lib/review/*.mjs`: the provider implementations.
- `.development/shared/runbooks/pr-iteration-runbook.md`: canonical how-to with full GraphQL recipes.
