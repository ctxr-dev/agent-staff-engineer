---
name: tracker-source-of-truth
description: The configured issue trackers are canonical. Local files are projections of tracker state, never the reverse. On conflict, the tracker wins and local files get rewritten.
portable: true
scope: every skill, every write, every read
---

# The configured tracker is the single source of truth

## The rule

On any project using this agent, **the issue trackers configured in `ops.config.json -> trackers.*` are the source of truth for dev work and release tracking.** That covers GitHub Issues + Projects v2, Jira issues + statuses, Linear issues, GitLab issues + merge requests, depending on what the project has configured for `trackers.dev` and `trackers.release`. Local markdown files, plan files, and reports are projections of tracker state. They do not define state; they reflect it.

When a local file disagrees with the tracker, **the tracker wins**. The local file gets rewritten from the tracker. Never the reverse.

## Why this matters

- Distributed teams need one place that agrees with everyone's view. A local plan on one machine is not that place.
- PR / MR merge, issue close, and reviewer assignment all live in the tracker. Any system that duplicates that state drifts.
- The agent's automation (release-tracker, regression-handler, adapt-system) reads the tracker to compute its diffs. If local files claim otherwise, the agent's output is wrong.
- For projects with multiple trackers (e.g. GitHub for code + Jira for tickets, or mid-migration with observed trackers), each configured target is authoritative within its scope. The agent never invents cross-tracker consensus.

## How to apply

1. Before proposing any work on an issue or PR / MR, fetch current state via `tracker-sync`. Do not trust a stale local plan one-liner.
2. When a skill produces an artefact that references an issue (PR body, regression report, plan one-liner), cite the issue by its tracker-native identifier (`#NNN` for GitHub, `PROJ-NNN` for Jira, `TEAM-NNN` for Linear, `!NNN` for GitLab merge requests). Do not duplicate the issue's body into the artefact.
3. When updating a plan file, update only the one-liner and the frontmatter. Keep the full issue body in the tracker.
4. If a contradiction appears (e.g. local plan says `[x]` but the tracker says `In progress`), flag it, fetch the tracker, rewrite the local one-liner to match. Never edit the tracker-side issue silently to match the plan.
5. Templates rendered into issue bodies via `tracker-sync` become the tracker's canonical content at creation. Later edits happen on the tracker, not on a local copy.

## Exceptions

- Working material under `ops.config.json -> paths.dev_working_dir` (default `.development/`) splits into three subtrees with different git policies. The `shared/` subtree commits with the project (team-visible reports, runbooks, configs) and is NOT source of truth for tracker state; it is provenance. The `local/` and `cache/` subtrees are per-user and gitignored by default; they are throwaway working notes.
- `ops.config.json` itself is local (it configures the agent) and is considered authoritative for agent configuration only. It does not override tracker state.

## What this rule is not

- Not a ban on local files. Plans, reports, runbooks all live on disk. They just do not own state that also lives in the tracker.
- Not a license to push to the tracker on every conversation. Writes still go through the approval gates in the dev-loop, adapt-system, and tracker-sync skills.

## Failure modes and escalation

- If the tracker's CLI / API is offline or rate-limited, the agent must not pretend local state is the truth. It should pause, surface the outage, and let the user decide whether to wait, retry, or proceed knowingly with stale reads.
- If two tracker targets disagree (e.g. the same issue referenced from `trackers.dev` and an entry in `trackers.observed`), the one declared as `dev` wins, and the agent surfaces the mismatch for the user.
- During a tracker migration (adapt-system's migration op), both the outgoing and incoming trackers are treated as authoritative within their respective scopes until cutover; cross-links between old and new items are emitted on new items so provenance stays intact.

## Related rules

- [pr-workflow.md](pr-workflow.md): how dev-loop moves state through the tracker.
- [plan-management.md](plan-management.md): how local plan files stay in sync.
- [adaptation.md](adaptation.md): how shape changes cascade through tracker state.
