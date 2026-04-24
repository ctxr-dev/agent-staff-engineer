---
name: dev-loop
description: Drives one dev issue from branch creation through local review, self-review, and PR opening, up to the In review status. Stops cold at the two human gates; never merges a PR, never sets an issue to Done.
trigger_on:
  - User picks a dev issue and asks the agent to work on it.
  - User explicitly runs /dev-loop <issue-number>.
do_not_trigger_on:
  - Issues in `Done` or closed without merge.
  - Targets where the dev_project has `depth` set to `read-only`.
  - Without a valid ops.config.json (halt and point at bootstrap-ops-config).
  - The dev issue already has an open PR whose branch is unknown locally, or two open PRs reference the same issue, or `tracker-sync` reports a status that contradicts local git state. Follow `rules/ambiguity-halt.md` (halt, surface the observation, ask); do not push, open, edit, close, or relabel anything while the question is open.
writes_to_github: yes, via tracker-sync only (branch push, PR open, reviewer requests, status updates to In review, comments)
writes_to_filesystem: yes, code edits plus a self-review report under paths.reports
---

# dev-loop

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if missing or invalid.

Hard rule baked in: **the dev-loop never merges a PR and never sets a dev issue to Done.** Both are human gates. Every code path ends either at `In review` (awaiting your merge) or at a halt with an explicit message.

## Inputs

- Issue reference (number or URL) on a `dev_project` with `depth` permitting writes. When the input is absent, unresolvable, or the issue is in a state dev-loop refuses to work on (Done, closed without merge, `depth: read-only`), dev-loop halts its own state machine at entry and hands off to `skills/issue-discovery/SKILL.md`. dev-loop resumes only once `issue-discovery` returns a handoff tuple conforming to `schemas/issue-discovery-handoff.schema.json` (`{issueRef, umbrellaRef | null, memberName | null}` on success, or `{cancelled: true}` on user-cancel at Q6).
- Optional work plan or acceptance-criteria override the user supplies up front.
- Optional workspace member. For single-repo projects, omit (the skill routes through `trackers.dev`). For multi-repo projects (`workspace.members[]` present), the skill resolves the owning member by walking the diff's file paths through `resolveMemberFromPath(cfg, filePath)` before picking the tracker via `pickTrackerForMember(cfg, memberName, "dev")`. Deepest-first match wins; files outside any nested member fall back to a root member ONLY when `workspace.members[]` contains an entry whose normalised path is `.`. Without an explicit root member, `resolveMemberFromPath` returns `null` for unmatched files and the caller routes through the top-level `trackers.dev` instead. When `issue-discovery` supplies `memberName`, this resolution step is skipped in favour of the supplied value.

## Outputs

- A branch following `workflow.branch_patterns.<type>`.
- Commits following `workflow.commits.style`, with scope derived per `workflow.commits.scope_source`.
- A self-review artefact under `workflow.code_review.report_dir` (default `.development/shared/reports/`).
- An open PR rendered from `templates/pr.md` with `workflow.pr.link_issue_with` referencing the issue.
- The dev issue updated to `In review` (via `tracker-sync`).
- Linked Release umbrella updated (via `release-tracker` triggered by `tracker-sync`). This step is skipped entirely when the project opted out of release umbrellas (`trackers.release` absent from `.claude/ops.config.json`): the `release-tracker` skill halts silently per its own `do_not_trigger_on` contract, and `workflow.pr.link_release_umbrella` is treated as false regardless of its configured value.
- Plan one-liner updated (via `plan-keeper`) when `workflow.pr.update_plan_oneliner` is true.

## State machine

```text
[issue: Backlog or Ready]
      |
      v
[branch from project.default_branch using workflow.branch_patterns]
      |
      v
[edit / implement against acceptance criteria]
      |
      v
[local review loop]
   format -> lint -> type -> unit -> integration -> e2e*
   * e2e required when any area label is in workflow.pr.e2e_required_on
      |
      |  any failure: halt, return to edit, do not push
      v
[self-review artefact produced]
   provider = workflow.code_review.provider
     = ctxr-skill-code-review (default): invoke the external skill
     = internal-template: render templates/code-review-report.md
     = none: skip only if workflow.pr.self_review_required is false
   verdict in workflow.code_review.block_on_verdict halts the flow
      |
      v
[git push branch]
      |
      v
[tracker-sync: open_pr using templates/pr.md]
[tracker-sync: review.requestReview per project.principals.reviewers_default]
[tracker-sync: issues.updateIssueStatus -> In review]
[plan-keeper: flip plan one-liner to [x]]
[release-tracker: recompute linked umbrella status]   (skipped when
                                                       trackers.release
                                                       is absent)
      |
      v
[hand off to skills/pr-iteration]
   request external reviewer (Copilot on GitHub) via GraphQL,
   poll for CI + review, triage threads, fix + push + resolve,
   iterate until all three exit conditions hold on current HEAD.
   Skipped when workflow.external_review.enabled is false, when
   workflow.external_review.provider is "none" (or the dispatcher
   otherwise resolves to kind "none"), or when the ReviewProvider
   dispatcher returns the stub for this tracker kind
   (Jira/Linear/GitLab today). See rules/pr-iteration.md.
      |
      v
***  HUMAN GATE 1: merge PR  ***
   dev-loop exits without further action on merge
      |
      v
***  HUMAN GATE 2: mark issue Done  ***
   dev-loop never initiates this step
```

## Code-review provider integration

Before pushing or opening the PR, the self-review step runs per `workflow.code_review`:

1. Look up `workflow.code_review.provider`. Trust the recorded value (validated at install time by `scripts/install.mjs`). Never prompt to switch provider mid-flow.
2. If the configured provider is `ctxr-skill-code-review` and the skill is not installed at runtime (e.g. manual config edit), halt with a clear error: "code-review provider ctxr-skill-code-review is configured but not installed. Run `/adapt-system "switch code-review provider"` to change, or install via `npx @ctxr/kit install @ctxr/skill-code-review`."
3. Invoke the provider with `workflow.code_review.invocation`, `mode`, `output_format`, scope = diff-since-default-branch.
4. Write the artefact to `workflow.code_review.report_dir` (which resolves under `.development/shared/reports/` by default). Per `rules/llm-wiki.md`, this write goes through `@ctxr/skill-llm-wiki` in a **nested, scalable layout**: never as a flat date-prefixed sibling, and never with a hand-rolled versioned filename (no `.v1.md`, `-v2.md`, or any user-visible `.vN` scheme; history lives in the skill's private git). Reports are a dated topic: the wiki must be built in hosted mode with `dynamic_subdirs.template: "{yyyy}/{mm}/{dd}"` so leaves land at `.../reports/{yyyy}/{mm}/{dd}/<slug>.md`. Consult the skill's SKILL.md for the exact leaf path and frontmatter shape, and invoke its validate/fix operation after the write so the wiki's index picks up the new leaf. If the current reports wiki still has flat date-prefixed siblings, run `skill-llm-wiki fix` or `rebuild` to migrate the layout before writing.
5. Parse the verdict; if in `workflow.code_review.block_on_verdict`, halt with the verdict and reviewer summary.

The ctxr-skill-code-review default is the recommended path. Projects opt out via `workflow.code_review.provider = "internal-template"` (falls back to [../../templates/code-review-report.md](../../templates/code-review-report.md)) or `"none"` when `workflow.pr.self_review_required` is false. Provider switching after install: `/adapt-system "switch code-review provider"`.

## Commit policy

- `workflow.commits.style = conventional`: title `<type>(<scope>): <summary>`, body contains the issue reference.
- Scope source per `workflow.commits.scope_source` (default `primary_area_label`).
- `workflow.commits.signed`: if true, sign commits; do not configure keys.

## Push policy

- Push to the feature branch only. Never to `project.default_branch`.
- If push is rejected because the branch was force-pushed by someone else, halt and surface; do not force-push.

## Idempotency

- Re-invoking `dev-loop` on an issue whose branch already exists resumes from the appropriate stage based on current branch/PR state: if no diff, prompt user; if diff but no PR, proceed from push; if PR open, proceed to comment-address loop.
- Does not duplicate PRs, reports, or status updates.

## Failure modes

- **Tests fail**: halt at the failing stage; do not push.
- **Code-review provider configured but not installed**: halt; surface error with remediation (`/adapt-system "switch code-review provider"` or install command).
- **Code-review verdict in `block_on_verdict`**: halt with the verdict and reasons.
- **PR template missing required sections**: halt and ask the user to fill them.
- **gh API failure during open_pr**: rollback any partial state (local commits stay, remote ref remains), halt and surface.
- **User tries to force dev-loop to mark issue Done**: explicit refusal; point at the human gate.

## Cross-skill handoffs

- `issue-discovery`: invoked at entry when no resolvable issue reference was supplied. dev-loop halts its own state machine until the intake interview returns a handoff tuple (or a cancelled marker). See `rules/issue-discovery.md` for the three-clause contract the intake honours.
- `tracker-sync`: open PR, request review, update issue status, post comments on the PR.
- `release-tracker`: triggered by `tracker-sync` side-effects when a dev issue moves or links change.
- `plan-keeper`: flip plan one-liner on gate crossings if `workflow.pr.update_plan_oneliner` is true.
- External skill `ctxr-skill-code-review`: invoked as the default self-review step.

## Project contract

- `project.default_branch`, `project.principals.push_allowed`, `project.principals.reviewers_default`.
- `trackers.dev` (needs `depth` that allows writes for the chosen target; project bindings live under `trackers.dev.projects[]` when `kind` is GitHub).
- `labels.type`, `labels.area`, `labels.priority`, `labels.size`, `labels.state_modifiers`.
- `workflow.branch_patterns.*`.
- `workflow.commits.style`, `workflow.commits.signed`, `workflow.commits.scope_source`.
- `workflow.pr.title`, `workflow.pr.body_template`, `workflow.pr.link_issue_with`, `workflow.pr.request_reviewers`, `workflow.pr.tests_required`, `workflow.pr.e2e_required_on`, `workflow.pr.self_review_required`, `workflow.pr.link_release_umbrella`, `workflow.pr.update_plan_oneliner`.
- `workflow.code_review.provider`, `workflow.code_review.invocation`, `workflow.code_review.mode`, `workflow.code_review.output_format`, `workflow.code_review.report_dir`, `workflow.code_review.block_on_verdict`, `workflow.code_review.install_hint`.
- `paths.plans_root`, `paths.reports`, `paths.templates`.
- `stack.testing` (to select test runners), `stack.language` (to select lint/format tools).
