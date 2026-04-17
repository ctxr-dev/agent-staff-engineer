---
name: github-source-of-truth
description: GitHub Issues and Projects are canonical. Local files are projections of GitHub, never the reverse. On conflict, GitHub wins and local files get rewritten.
portable: true
scope: every skill, every write, every read
---

# GitHub is the single source of truth

## The rule

On any project using this agent, **GitHub Issues and the GitHub Projects configured in `ops.config.json -> github.*` are the source of truth for dev work and release tracking.** Local markdown files, plan files, and reports are projections of GitHub. They do not define state; they reflect it.

When a local file disagrees with GitHub, **GitHub wins**. The local file gets rewritten from GitHub. Never the reverse.

## Why this matters

- Distributed teams need one place that agrees with everyone's view. A local plan on one machine is not that place.
- PR merge, issue close, and reviewer assignment all live in GitHub. Any system that duplicates that state drifts.
- The agent's automation (release-tracker, regression-handler, adapt-system) reads GitHub to compute its diffs. If local files claim otherwise, the agent's output is wrong.

## How to apply

1. Before proposing any work on an issue or PR, fetch current state via `github-sync`. Do not trust a stale local plan one-liner.
2. When a skill produces an artefact that references an issue (PR body, regression report, plan one-liner), cite the issue by `#NNN`. Do not duplicate the issue's body into the artefact.
3. When updating a plan file, update only the one-liner and the frontmatter. Keep the full issue body in GitHub.
4. If a contradiction appears (e.g. local plan says `[x]` but GitHub issue is `In progress`), flag it, fetch GitHub, rewrite the local one-liner to match. Never edit the GitHub issue silently to match the plan.
5. Templates rendered into issue bodies via `github-sync.create_issue` become the issue's canonical content at creation. Later edits happen on GitHub, not on a local copy.

## Exceptions

- Working material under `ops.config.json -> paths.dev_working_dir` (default `.development/`) splits into three subtrees with different git policies. The `shared/` subtree commits with the project (team-visible reports, runbooks, configs) and is NOT source of truth for GitHub state; it is provenance. The `local/` and `cache/` subtrees are per-user and gitignored by default; they are throwaway working notes.
- `ops.config.json` itself is local (it configures the agent) and is considered authoritative for agent configuration only. It does not override GitHub state.

## What this rule is not

- Not a ban on local files. Plans, reports, runbooks all live on disk. They just do not own state that also lives in GitHub.
- Not a license to push to GitHub on every conversation. Writes still go through the approval gates in the dev-loop, adapt-system, and github-sync skills.

## Failure modes and escalation

- If `gh` is offline or rate-limited, the agent must not pretend local state is the truth. It should pause, surface the outage, and let the user decide whether to wait, retry, or proceed knowingly with stale reads.
- If two GitHub targets disagree (e.g. the same issue referenced from two observed repos), the one declared in `github.dev_projects[0]` wins, and the agent surfaces the mismatch for the user.

## Related rules

- [pr-workflow.md](pr-workflow.md): how dev-loop moves state through GitHub.
- [plan-management.md](plan-management.md): how local plan files stay in sync.
- [adaptation.md](adaptation.md): how shape changes cascade through GitHub state.
