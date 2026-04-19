---
name: pr-iteration
description: The post-push PR iteration loop. After dev-loop opens a PR, the agent enters this loop, requests an external reviewer, polls for CI and review, triages unresolved threads, fixes + pushes + resolves, and iterates until all three exit conditions hold. Stops cold at the merge human gate.
portable: true
scope: every session that opened a PR via dev-loop and has workflow.external_review.enabled
---

# PR iteration loop

## The rule

After `dev-loop` opens a PR, the agent enters the **PR iteration loop** until all three exit conditions hold on the current HEAD:

1. **Local code-review says GO** on current HEAD.
2. **Zero unresolved review threads** on HEAD, AND the most recent external review is on the current HEAD SHA.
3. **CI is SUCCESS on current HEAD** across every required job.

When all three hold, the agent reports the final state to the human and stops. **PR merge is a human gate. The agent never merges.** The canonical runbook with the full GraphQL recipes and edge-case handling lives in the bundle at `skills/pr-iteration/runbook.md`; this rule is the binding contract, the runbook is the how-to. Target projects that want to mirror the runbook into their own wiki do so via `@ctxr/skill-llm-wiki` per `rules/llm-wiki.md`; the canonical source stays in the bundle.

## State machine inside the loop

Each round is the same six steps. The loop repeats until the exit conditions hold.

1. **Assert local review GO on HEAD.** Delegate to `rules/review-loop.md`. If the local review is not GO, fix and re-run before pushing. Never push with outstanding Critical or Important findings.
2. **Push** the feature branch to `origin`. Re-use the existing branch; do not rename between rounds.
3. **Request external review** on current HEAD via `ReviewProvider.requestReview`. Implementation for GitHub is in `scripts/lib/review/github.mjs` and uses the `requestReviews` GraphQL mutation with `botIds`. The REST endpoint silently no-ops for bots; never use it.
4. **Poll** at `workflow.external_review.poll_interval_seconds` (default 30s). Stop polling when CI reaches a terminal state (`SUCCESS` / `FAILURE` / `ERROR`) AND (any unresolved threads exist OR the reviewer has posted a review on the current HEAD). Cap the wait at `poll_timeout_seconds` (default 1200s) and surface a clear timeout to the human if hit.
5. **Fetch unresolved threads** via `ReviewProvider.fetchUnresolvedThreads`. Triage into three buckets (the runbook documents the detection heuristics):
   - **Stale**: the reviewer re-emitted a comment on already-fixed code (same `path:line`, unchanged content since the last push, or posted on a superseded SHA). Mark for resolution without a code change. The agent tracks the recurrence count per thread fingerprint and auto-resolves once the count crosses `auto_resolve_stale_after_commits` (default 1), surfacing the decision in the per-round report. Set the threshold to `0` to require manual triage for every thread.
   - **Net-new actionable**: real issue. Fix. Lock the fix in with a regression test when the issue was behavioural (security, TOCTOU, exit code, parsing).
   - **Suggestion / style**: take or push back with a reply on the thread.
6. **Commit + push + resolve threads + re-request**. One commit per round, `fix(review-round-N): <short summary>` with a per-thread bullet list in the body naming `path:line` and what changed. After the push, call `ReviewProvider.resolveThread(threadId)` for every addressed thread, then `ReviewProvider.requestReview` again on the new HEAD. Loop back to step 4.

## Stop conditions

- All three exit conditions hold: report state, write a final `pr-iteration-report.md` artefact into the wiki (per `rules/llm-wiki.md`), and stop. Never merge.
- Poll timeout: surface the timeout with the last-known poll state and stop without committing any changes. Human decides whether to keep waiting, investigate CI, or close the PR.
- Provider declines (`NotSupportedError`): the provider is the stub for this tracker kind. Surface a clean "pr-iteration not supported for tracker kind '<kind>'; halting at In review" message to the human and stop. Do not fall back to a silent no-op.
- CI goes red: fetch failed-step log lines, include them in the round's report, fix, re-push. Same loop.

## Per-round artefact

Every round writes a `pr-iteration-report.md` into `.development/shared/reports/` via the wiki (per `rules/llm-wiki.md`): round number, previous and new HEAD SHAs, `requestReview` outcome, poll result, threads resolved / stale / deferred, commits in the round, exit-condition status at end of round. The wiki's own SKILL.md decides placement and frontmatter.

## Config (`workflow.external_review`)

- `enabled` (default `true`): flip to `false` to skip the loop entirely. `dev-loop` then halts at "In review" like the pre-PR-2 behaviour.
- `provider` (`auto` / `github` / `none`): `auto` picks from `trackers.dev.kind` via the dispatcher; `github` forces the GitHub impl (for projects where code lives on GitHub but tickets are elsewhere); `none` is equivalent to `enabled: false`.
- `bots`: per-kind map of reviewer LOGINS (portable across repos). For GitHub each value is the bot's login string (e.g. `copilot-pull-request-reviewer`). The skill resolves each login to its GraphQL node ID once per PR via the capture recipe below and caches the mapping in the in-memory iteration state. Config never stores node IDs: they vary across installations and are not portable.
- `poll_interval_seconds`, `poll_timeout_seconds`, `auto_resolve_stale_after_commits`: see the schema for ranges and defaults.

## Capturing the Copilot bot node ID (GitHub)

The Copilot bot has a stable GraphQL node ID per repo. Capture it once via:

```bash
gh api graphql -f query='
  { repository(owner:"OWNER",name:"REPO"){pullRequest(number:N){
      reviews(last:10){nodes{author{... on Bot{id login}}}}
  }}}'
```

Pick the `id` whose `login` is `copilot-pull-request-reviewer`. If the repo has no prior Copilot review yet, request one via the repo's Settings or via a first-round `requestReviews` without `botIds` and the bot seeds itself.

## Related

- `rules/pr-workflow.md`: full PR state machine (branch -> edits -> local review -> push -> In review -> **iteration loop** -> merge human gate -> Done human gate).
- `rules/review-loop.md`: the pre-push local review.
- `skills/pr-iteration/SKILL.md`: the orchestration skill this rule governs.
- `skills/pr-iteration/runbook.md`: the canonical how-to with GraphQL snippets and known gotchas. Lives in the bundle so the lint + dash validators cover it; target projects mirror into their wiki via `@ctxr/skill-llm-wiki`.
