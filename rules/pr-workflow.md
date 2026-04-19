---
name: pr-workflow
description: The PR workflow state machine, from branch creation to In review. Two human gates (merge, Done) are never crossed by the agent.
portable: true
scope: dev-loop and anything that touches a PR or a dev issue's status
---

# PR workflow

## The rule

Every code change the agent drives follows the same state machine from branch creation through `In review`. **The agent never merges a PR. The agent never moves a dev issue to Done.** Both are human decisions.

## States and transitions

```text
[issue: Backlog or Ready]
   |
   | agent starts work
   v
[branch created from default_branch]
   |
   v
[edits, commits]
   |
   v
[local review loop: format, lint, type, unit, integration, e2e where applicable]
   |
   |  any failure: back to edit, no push
   v
[self-review artefact produced]
   |
   |  verdict in workflow.code_review.block_on_verdict: halt
   v
[push; PR opened; reviewers requested; issue -> In review]
   |
   v
[pr-iteration loop: request external reviewer (Copilot on GitHub),
 poll for CI + review, triage unresolved threads, fix + push +
 resolve, iterate until all three exit conditions hold on current
 HEAD. Governed by rules/pr-iteration.md.]
   |  skipped when workflow.external_review.enabled is false, when
   |  workflow.external_review.provider is "none" (or the dispatcher
   |  otherwise resolves the provider kind to "none"), or when the
   |  ReviewProvider dispatcher returns the stub for the configured
   |  tracker kind (Jira/Linear/GitLab today).
   v
***  HUMAN GATE 1: PR merge  ***
   |
   v
[PR merged]
   |
   v
***  HUMAN GATE 2: dev issue -> Done  ***
   |
   v
[issue: Done]
```

## What the agent must do

1. Branch from the branch named in `ops.config.json -> project.default_branch` only.
2. Use the branch pattern in `ops.config.json -> workflow.branch_patterns.<type>`. Never invent a branch name outside the configured patterns.
3. Run the full local review loop. Never skip a stage declared in `workflow.pr.tests_required` or `workflow.pr.e2e_required_on`.
4. Produce a self-review artefact. Default provider is the external `ctxr-skill-code-review` skill; fall back only per `workflow.code_review.provider`.
5. Open the PR with body rendered from `workflow.pr.body_template`, title from `workflow.pr.title`, linked with `workflow.pr.link_issue_with`.
6. Request reviewers from `project.principals.reviewers_default` and any extras in `workflow.pr.request_reviewers`.
7. Move the linked dev issue to `In review` via `tracker-sync`, not by direct `gh` call.
8. Update the Release umbrella via `release-tracker` as a side-effect of the issue's status change.
9. Keep the one-liner in the plan file in sync via `plan-keeper` when `workflow.pr.update_plan_oneliner` is true.
10. On review comments, iterate, push again, keep the issue at `In review`. Never regress the status to `In progress` on a new push.

## What the agent must not do

- Merge a PR. No exceptions. Not on user request, not with `--force`, not because CI is green. Merge belongs to a human.
- Set a dev issue to `Done`. The agent can pass it to `In review`. Done belongs to a human.
- Push to `project.default_branch`. Ever.
- Skip a stage in the local review loop because "we know this will pass".
- Open a PR without a self-review artefact when `workflow.pr.self_review_required` is true.
- Open a PR against a non-default branch silently. If the user wants a stacked PR or a long-lived integration branch, that is an explicit user direction, not a default.

## Commit policy

- Follow `workflow.commits.style`. Default is Conventional Commits with area-derived scope.
- Sign commits only when `workflow.commits.signed` is true. Do not configure keys on behalf of the user.
- Keep commits focused; prefer several small commits over one enormous one when it aids review.

## Reviewer policy

- Always request `project.principals.reviewers_default` plus whatever is declared in `workflow.pr.request_reviewers`.
- External-reviewer orchestration (requesting Copilot, polling, thread triage) is governed by `rules/pr-iteration.md`. This rule names WHOM to request; `pr-iteration.md` drives HOW the request lifecycle plays out.
- If Copilot is configured as a reviewer but is unavailable on the repo or org, `pr-iteration` surfaces the absence and falls back to the human reviewers. Never silently drop the request.
- Do not approve a PR the agent opened. Never.

## The two gates

Gate 1, PR merge, is the user's decision.

Gate 2, dev issue to Done, is the user's decision and is separate from the merge. Merging the PR closes the issue via `Closes #NNN`, but GitHub's closed state is not the agent's Done. The agent only recognises the `Done` status option on the configured dev project, and that option gets set by the user.

## Escalation

- If an external code-review provider returns a `NO-GO` verdict (or any verdict in `workflow.code_review.block_on_verdict`), the agent halts the PR open. The user decides whether to override with a conscious instruction.
- If a hook or CI check blocks the push for a reason the agent cannot diagnose, halt and surface; do not bypass.

## Related rules

- [tracker-source-of-truth.md](tracker-source-of-truth.md)
- [review-loop.md](review-loop.md)
- [plan-management.md](plan-management.md)
