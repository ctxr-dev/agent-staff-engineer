# agent-staff-engineer

[![npm](https://img.shields.io/npm/v/@ctxr/agent-staff-engineer)](https://www.npmjs.com/package/@ctxr/agent-staff-engineer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An AI staff engineer for your software project. It picks up tickets, writes code, reviews its own work, opens pull requests, responds to reviewer comments, and drives changes all the way up to the point of merge. It stops there and hands the decision to you. **GitHub is the only tracker with a working implementation today**; the config and bootstrap interview also accept Jira, Linear, and GitLab, but those backends are placeholders that throw `NotSupportedError` until their real implementations land (see the Current implementation status table below). It reads your project's config once so every action it takes is consistent with how your team already operates.

## What it actually does for you

**Sets itself up.** On first run it asks you a short set of questions (release cadence, team size, which tracker hosts your tickets, e2e setup, compliance context) and writes a single config file. Everything downstream reads from that file, so the agent behaves predictably across sessions.

**Drives the full issue-to-PR loop.** You point it at an issue. It creates a branch, implements the change, runs the full local review chain (format, lint, type-check, unit, integration, e2e where applicable), delegates code review on its own work to [`@ctxr/skill-code-review`](https://github.com/ctxr-dev/skill-code-review), opens a PR with reviewers requested and the right template applied, moves the issue to "In review", and stops. You merge.

**Iterates on review comments until the PR is green.** After the PR is open, it requests an external reviewer (e.g. GitHub Copilot), polls CI and review threads, classifies each unresolved comment as *stale*, *actionable*, or *suggestion*, fixes the actionable ones, commits, pushes, resolves what it addressed, re-requests review, and loops until three conditions hold: local review is still green, every thread is resolved, CI is green on the current commit.

**Adapts when your project changes.** Tell it in plain English: "we handle PHI now", "we added a Chrome extension target", "we're migrating from Jira to Linear", "dropped the legacy analytics SDK". It produces a preview diff across your config, your label taxonomy, your issue templates, your internal rules, and its own memory. Nothing is written until you approve.

**Keeps plan files honest.** Plan files under `.claude/plans/` get moved through `todo → in-progress → in-review → done` folders automatically, stay in the right checkbox format, and have their one-line status (the `[ ]` / `[x]` marker and the frontmatter) kept in sync with the linked tracker issue. If a plan says `[x]` but the tracker says "In progress", the local checkbox is rewritten to match the tracker. The plan body stays yours.

**Tracks releases.** Release umbrella issues have their status computed automatically from their linked dev issues. The umbrella body gets a live summary (`2 Done / 1 In review / 3 In progress / 6 Backlog`) plus a blocker list. The agent auto-moves the umbrella through Backlog → In progress, but never to Done (that's you).

**Triages regressions.** When you report a bug, it looks up historical closed issues by commit, file path, area label, or title keyword, and proposes: reopen the original, file a new linked bug, or investigate further. It writes a regression report with its reasoning so you can audit the decision.

**Reconciles label taxonomy.** When your label set changes (you added a new `area/*` or renamed `priority/*`), it computes an add / edit / deprecate plan and applies it after you approve.

## Two things it will never do

These are non-negotiable, baked into every skill:

1. **It never merges a PR.** Period.
2. **It never sets a dev issue to `Done`.** Period.

These two decisions are always yours.

## Hard rules the agent always follows

- **Your tracker is the single source of truth.** Configured in `trackers.*`. When a plan file's status marker conflicts with the tracker (e.g. plan says `[x]` but the tracker issue is "In progress"), the plan file's status line is rewritten to match the tracker. Scope of this rule, specifically: plan-file one-liners and frontmatter under `.claude/plans/`. It does NOT rewrite your source code, your README, your `CLAUDE.md`, your `ops.config.json`, the body of a plan file, your reports under `.development/shared/`, or anything the tracker itself holds. The rule stops at "status markers in local plan files".
- **No em or en dashes** in anything the agent writes: issue bodies, PR descriptions, comments, plan files. Uses commas, colons, parentheses, or line breaks.
- **Never runs destructive git commands.** No `reset --hard`, no `--force`, no discarding uncommitted changes.
- **Never amends commits.** Every change is a new commit so history stays reviewable.
- **Runs the full local review loop before pushing.** If any gate is red, it fixes and re-runs before it pushes.
- **Halts and asks when state is ambiguous** (weird branch, orphan PR, contradictory status) rather than guessing.
- **Never touches your project's `daily/` or `knowledge/` folders.** Those belong to your own tooling.
- **Never writes above the managed block in your `CLAUDE.md`.** Your hand-written content is preserved byte-for-byte across agent updates.

## Current implementation status

The agent targets four tracker kinds; today only GitHub is backed by real implementations. Other kinds accept the config in the interview but surface a clean "not implemented yet" error on any operation.

| Capability                             | GitHub                                | Jira / Linear / GitLab |
| -------------------------------------- | ------------------------------------- | ---------------------- |
| Open PRs, iterate on review comments   | **works**                             | stub (`NotSupportedError`) |
| Status moves, comments, issue create   | partial (works via legacy path; the new unified API is being ported) | stub |
| Label taxonomy reconcile               | partial                               | stub |
| Release umbrella status                | **works**                             | stub |
| Regression lookups                     | **works**                             | stub |
| Bootstrap interview + config           | **works**                             | **works** (config is valid; write-ops throw until real backends land) |

Real Jira / Linear / GitLab backends ship in follow-up releases. Today, the only **observed** (read-only) target kind the interview and runtime actually wire up is GitHub repos (for cross-repo lookups). The schema accepts observed Jira / Linear / GitLab entries, but every operation against them throws `NotSupportedError` because those backends are full stubs end-to-end: there's no path that reads from them either. Treat those kinds as "not implemented yet" full stop until the real backends land.

## Release models the interview supports

The interview's cadence question picks which umbrella rhythm fits your project:

- **Per-wave / per-sprint** (the default; one umbrella per `intent` label value like `wave-1`, `wave-2`).
- **Per-version** (`initial`, `v1`, `v2`, ...). Pick `per-version` in the cadence question.
- **Continuous** (minimal: just `initial` and `post-launch`). Pick `continuous` in the cadence question.

Teams that don't coordinate releases with umbrella issues (solo dev on tag-based continuous deploy, milestone-only workflows) answer `no` to the release-umbrella question in the interview. The agent omits `trackers.release` from the generated config; `release-tracker` halts silently and `dev-loop` skips the link-umbrella step.

## Multi-repo workspaces

For projects where sibling directories have their own git repos and possibly different trackers (e.g., a Jira-tracked library next to a GitHub-tracked app), the interview asks you to declare each member: project-relative path, short name, and its own dev tracker (plus optional release tracker). The runtime dispatcher (`pickTrackerForMember` / `resolveMemberFromPath`) routes each operation through the owning member deepest-first: a file under `libs/shared/x.ts` resolves to the `libs/shared` member; files outside any nested member fall back to the root. Single-repo projects answer `no` and keep the single-tracker path with zero config overhead.

## Quick start

```bash
# 1. Install the agent. Kit offers an interactive menu for the destination:
#    .claude/agents/, .agents/agents/, ~/.claude/agents/, or a custom --dir.
npx @ctxr/kit install @ctxr/agent-staff-engineer
```

Then in Claude Code, ask Claude to run the agent, for example:

```text
Run the agent-staff-engineer and help me set it up for this project.
```

On first run, the agent detects that `.claude/ops.config.json` is missing and self-bootstraps: it runs its own installer, launches the interactive interview (ten topics covering release cadence, team size and push principals, e2e setup, which tracker hosts dev issues (GitHub / Jira / Linear / GitLab) plus the target coordinates, whether you coordinate releases with umbrella issues (and if so, which tracker hosts them), whether to customise branch naming, whether this is a multi-repo workspace (and if so, each member's path + tracker binding), additional repos to observe, observation depth, compliance context, optional project-specific rules to seed), writes `ops.config.json`, generates thin wrapper files at the canonical Claude Code locations, and hands control back.

On every later invocation the agent acts on your request directly, guided by the configured rules.

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI or IDE extension.
- **Node.js 20+** (preflight enforces this and offers platform-specific install guidance on mismatch).
- **Git** (for the bundle repo + dev loop operations).
- A tracker CLI or token matching `trackers.*.kind` in `ops.config.json`:
  - **GitHub**: `gh` CLI authed with scopes `repo`, `project`, `read:org`, `workflow`.
  - **Jira**: `JIRA_API_TOKEN` env var (optionally `jira-cli` if present).
  - **Linear**: `LINEAR_API_KEY` env var.
  - **GitLab**: `GITLAB_TOKEN` env var (optionally `glab` if present).
  - Jira / Linear / GitLab backends are placeholders on this release; every op throws `NotSupportedError`. Real backends land in follow-up releases.

## Required companion skill

The agent requires [`@ctxr/skill-llm-wiki`](https://github.com/ctxr-dev/skill-llm-wiki) to be installed before it can apply its initial config. Every document under `.development/**` (reports, plans, runbooks) is managed as a semantically-routed LLM wiki by that skill, so the agent can navigate its own history without re-reading everything on every session.

**What happens when it's missing:**

- **Interactive install (you're sitting at a terminal):** the installer pauses, tells you which skill is missing, prints the exact command to run (`npx @ctxr/kit install @ctxr/skill-llm-wiki`), and waits for you. Run the install in another terminal, press Enter, and the agent rechecks and continues. At the prompt you can also type `help` (prints troubleshooting tips for common install failures, lets you ask the agent for help debugging) or `abort` (cancels cleanly). The installer never silently proceeds without the dependency.
- **Non-interactive / scripted install (CI, `--yes`, piped stdin):** the installer prints the same "missing skill" message with the install command and exits non-zero so the pipeline fails fast. Install the skill and re-run.

You can opt out entirely by setting `wiki.required: false` in `ops.config.json`, but then you own `.development/` yourself.

## How it works under the hood

- **Installable via kit.** One command places the bundle; one more (or just "run the agent") bootstraps it.
- **Wrapper model**: canonical skills, rules, and memory seeds stay inside the bundle folder. The installer writes thin wrappers at `.claude/skills/agent-staff-engineer_<name>/SKILL.md`, `.claude/rules/agent-staff-engineer_<name>.md`, and `.claude/memory/seed-agent-staff-engineer_<name>.md`. The agent-name prefix is derived from `package.json -> name` so wrappers never collide with files shipped by other agents or skills. Each wrapper points at the canonical file and has a marker line; anything you add below the marker survives every update.
- **Auto-update via `git pull`** inside the bundle folder. Wrappers reference stable in-bundle paths, so content updates take effect immediately. Run `install.mjs --update` only when the canonical file set or schema changes.
- **Interactive bootstrap** asks the right questions; user input wins over heuristic detections.
- **Continuous adaptation**: the `adapt-system` skill takes free-form user intent ("we handle PHI now", "we added a Chrome extension target", "dropped the legacy analytics SDK") and produces cascading diffs across config, labels, templates, rules, and memory seeds. Idempotent, diff-previewed, never silent.
- **Multi-tracker observation**: the config's `trackers` block binds a dev tracker, a release tracker, and zero or more read-only `observed` trackers (each independently kinded across github / jira / linear / gitlab). Every entry carries its own depth setting (`full`, `umbrella-only`, `assigned-to-principals`, `labeled:X`, `issues-only`, `read-only`). Multi-repo workspaces route per-member via the optional top-level `workspace.members[]` block.
- **Code review default**: the `dev-loop` skill delegates self-review to [`@ctxr/skill-code-review`](https://github.com/ctxr-dev/skill-code-review) (up to 18 specialist reviewers, GO / CONDITIONAL / NO-GO verdict). Configurable; falls back to an internal template on projects that have not installed the external skill.

## Manual install (without kit)

```bash
git clone https://github.com/ctxr-dev/agent-staff-engineer.git .claude/agents/agent-staff-engineer
node .claude/agents/agent-staff-engineer/scripts/install.mjs --target . --apply
```

The scripts self-locate via `import.meta.url`, so they work regardless of where kit or you placed the bundle.

## Structure

- `AGENT.md`: Claude Code agent entry point with self-bootstrap instructions.
- `bundle-index.md`: routing doc; the agent reads this first to jump to the relevant skill / rule rather than re-reading everything.
- `skills/`: workflow skills (bootstrap-ops-config, adapt-system, tracker-sync, dev-loop, release-tracker, regression-handler, plan-keeper, pr-iteration).
- `rules/`: portable process rules (tracker as source of truth, PR workflow, pr-iteration, ambiguity-halt, no dashes, plan management, review loop, memory hygiene, adaptation, llm-wiki).
- `memory-seeds/`: starter memory entries, stack-tag filtered at install time.
- `templates/`: issue / PR / report templates with `{{ placeholder }}` substitution.
- `schemas/ops.config.schema.json`: strict JSON Schema validated on every install.
- `scripts/`: Node.js ESM installer, bootstrap, adapt, seed installer, validator, preflight, update_self, plus shared helpers under `scripts/lib/` (including `scripts/lib/trackers/` which holds the Tracker interface and per-kind implementations).
- `examples/`: fully-populated fictitious example config.
- `tests/`: `node:test` unit + E2E.
- `design/`: MASTER-PLAN, DECISIONS, ARCHITECTURE, OPEN-QUESTIONS, RISKS.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add skills, rules, or seeds. See [INSTALL.md](INSTALL.md) for the full install reference including update and uninstall.

## Releasing

Releases are PR-gated. Version bumps land on `main` through a review gate like any other change; only the tag push is automated.

### One-time setup

Enable these on the repo before your first release:

- Repository secret `NPM_TOKEN` set to an npm access token with publish rights on the `@ctxr` scope (`npm token create`).
- **Settings → Actions → General → Workflow permissions**: enable **Allow GitHub Actions to create and approve pull requests** so `release.yml` can open its version-bump PR with `GITHUB_TOKEN`. If the checkbox is greyed out, an organization-level Actions policy is restricting it; ask an org admin to unlock the setting first.
- (Optional, recommended) GitHub-managed CodeQL default setup: Security → Code security → enable default setup for `javascript-typescript` and `actions`.
- (Optional) A branch ruleset on `main` requiring PR review + code scanning. The release flow works without it; gates are strictly stricter when enabled.

### Cutting a release

1. **Actions → Release → Run workflow**.
   - Branch selector: `main` (the workflow refuses any other ref).
   - Version bump: `patch` / `minor` / `major`.
   - Click **Run workflow**.
2. The workflow bumps `package.json` (and `npm-shrinkwrap.json` when present) on a fresh `release/v<version>` branch and opens a PR to `main` titled `release: v<version>`.
3. Review the PR (diff is just version fields). Approve + merge.
4. On merge, `tag-on-main.yml` fires automatically:
   - Detects the version change.
   - Creates and pushes the annotated `v<version>` tag via `GITHUB_TOKEN`.
5. **Actions → Publish to npm → Run workflow** on the `v<version>` tag. The workflow runs `npm ci + preflight + validate + lint + test`, verifies the tag matches `package.json`, and publishes the package to npm.

> **Why a manual dispatch for step 5?** GitHub's built-in `GITHUB_TOKEN` cannot trigger further workflows (`on: push: tags` won't fire when a workflow pushed the tag). So the tag auto-creation stops at the tag. Publishing is one extra click. To make it fully automatic, swap the push credential in `tag-on-main.yml` for a GitHub App token or fine-grained PAT stored as a repo secret, then the `push: tags` trigger on `publish.yml` will fire and step 5 happens by itself.

From **Run workflow** on Release to **published on npm** is one dispatch + one PR merge + one dispatch (or one dispatch + one PR merge, once a PAT/App-token is wired in).

See [GitHub Releases](https://github.com/ctxr-dev/agent-staff-engineer/releases) for the changelog.

### Troubleshooting

- **Release workflow fails with "Release workflow must be dispatched from main"**: you selected a feature branch in the Actions UI. Re-dispatch with `main`.
- **`tag-on-main` fails with "Tag vX.Y.Z exists on the remote but points at …"**: a stale or orphan tag from a prior failed release. Delete and re-run:

  ```bash
  git push origin --delete vX.Y.Z
  ```

  Then merge a trivial no-op PR to `main` (or revert-and-re-merge the release PR) to retrigger `tag-on-main`. Direct pushes to `main` may be blocked by branch protection, so the PR path is the reliable retrigger.
- **`publish.yml` fails on "Verify version matches tag"**: tag and `package.json` disagree. Investigate the merge commit; this should not happen under the PR-based flow.
- **GitHub Actions is not permitted to create pull requests**: org or enterprise policy blocks the `GITHUB_TOKEN` from opening PRs. Enable **Allow GitHub Actions to create and approve pull requests** at the org level (Settings → Actions → General → Workflow permissions), or ask the enterprise admin to unlock the setting.
