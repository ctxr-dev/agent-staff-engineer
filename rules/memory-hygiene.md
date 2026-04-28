---
name: memory-hygiene
description: What Claude memory captures for an installed project, what it does not, and how the agent stays out of a project's existing memory. Seeds are installed once; ongoing memory is the project's job.
portable: true
scope: every session running on a project that installed this agent
---

# Memory hygiene

## The rule

The agent ships a small set of generic memory seeds under `memory-seeds/`. At install time, a filtered set of those seeds is surfaced as **wrapper memory entries** in the target project's Claude memory folder (one time). Each wrapper is a thin file at `.claude/memory/seed-<agent-prefix>_<name>.md` that references the canonical seed inside the bundle; the seed content itself is never copied. After install, **the target project's memory belongs to the project**, shaped by its own sessions under Claude's normal memory rules. The agent does not rewrite, audit, or prune that memory later.

Project memory is not part of the portable bundle. It is not source of truth for anything the agent reads; it is a convenience for humans working on the project.

## What gets saved to project memory

On a given project, Claude memory should capture:

- **User profile** entries: the user's role, preferences, areas of ownership on this project.
- **Feedback** entries: corrections and confirmations that should shape future behaviour on this project. Include `**Why:**` and `**How to apply:**` lines so future Claude can judge edge cases.
- **Project** entries: current initiatives, deadlines, stakeholders, decisions whose motivation is not derivable from the code.
- **Reference** entries: pointers to external systems (Linear board, Grafana dashboard, Slack channel).

## What does not belong in project memory

- Code patterns, architecture, file paths, conventions. Read the code.
- Git history, recent PRs, who-changed-what. Use `git log` and `gh`.
- Debugging solutions or fix recipes. The commit message already captures this.
- Anything in the project's `CLAUDE.md` or `ops.config.json`. Those are authoritative.
- Daily-log entries. Those belong to the project's daily system, which the agent does not touch.

## What the agent does at install

- Runs `install_memory_seeds.mjs`. Filters `memory-seeds/` by the tags in `ops.config.json -> stack.*`. Writes a wrapper memory entry per selected seed into the project's Claude memory folder at `seed-<agent-prefix>_<name>.md`. The wrapper references the canonical seed inside the bundle; running `git pull` inside the bundle refreshes the canonical content without rewriting wrappers.
- Prints a summary of which seed wrappers were installed and which were skipped.

## What the agent does not do after install

- Does not edit existing memory entries that were present before the agent arrived.
- Does not rewrite seeds that were already installed on a previous install (unless `--force` is passed to the seed installer).
- Does not run a "memory audit" sweep. That is outside the agent's scope.
- Does not sync memory to any external system.

## Seed install is idempotent

- Running `install_memory_seeds.mjs` twice writes no new files the second time unless the seed content changed.
- Running it with `--force` rewrites the seed files but preserves manually edited notes the user added around them.

## What Claude sessions should do on any project

- When the user shares useful feedback or context, save a memory entry in the appropriate category.
- When a saved memory turns out stale, update or remove it rather than acting on outdated information.
- Before acting on a recalled memory that names a specific file or flag, verify the thing still exists.

## Escalation

- If a project's memory folder contains entries that contradict this bundle's rules (say, an old entry that said "Claude merges PRs on request"), raise the contradiction with the user. Do not silently override and do not silently follow.
- The agent never rewrites memory on behalf of the user. It proposes; the user decides.

## CLAUDE.md is institutional registry, not prompt dump

Project memory (the topic of this rule) is per-Claude, ephemeral across machines. The project's `CLAUDE.md` is the cross-team, version-controlled counterpart: a **compound-learning registry** that distils patterns that worked, patterns that failed, and codebase quirks. Convergent 2026 research finds human-curated CLAUDE.md raises agent success ~ 4 %; AI-generated CLAUDE.md slightly lowers it. The difference is editorial, not generative.

- Authoring guide: [`design/claude-md-authoring.md`](../design/claude-md-authoring.md).
- Registry template: [`templates/claude-md/compound-learning.md`](../templates/claude-md/compound-learning.md).
- Append API (idempotent upsert + CLI): [`scripts/lib/claude-md/append-entry.mjs`](../scripts/lib/claude-md/append-entry.mjs).

Memory captures session-specific feedback and corrections per Claude's normal hygiene; CLAUDE.md captures distilled, durable patterns that the team votes on via PR review. Do not duplicate one in the other.

## Related rules

- [tracker-source-of-truth.md](tracker-source-of-truth.md): memory is not source of truth.
- [adaptation.md](adaptation.md): adapt-system may propose installing new seeds when stack changes, but never rewrites the user's memory silently.
