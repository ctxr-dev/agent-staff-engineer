---
name: bootstrap-ops-config
description: Interactive cold-start of ops.config.json for a target project. Detects what it can via git, gh, and filesystem, then interviews the user on the rest, respecting user input over heuristics. Produces a validated ops.config.json and a .bootstrap-answers.json transcript. Never mutates GitHub.
trigger_on:
  - First install of the agent into a target project (invoked by install.mjs).
  - User explicitly requests a re-bootstrap (rare; prefer adapt-system for incremental changes).
do_not_trigger_on:
  - Any scenario where ops.config.json already exists and is valid. Use adapt-system instead.
  - Projects where gh is not authed or git remote is absent. Print guidance and halt.
writes_to_github: false
writes_to_filesystem: writes only ops.config.json, .bootstrap-answers.json, and CLAUDE.md in the target (via install.mjs).
---

# bootstrap-ops-config

Before acting, read the target project's `.claude/ops.config.json` **if present**. If it exists and validates against `schemas/ops.config.schema.json`, do not run; tell the user to use `adapt-system` instead.

Turns a fresh clone into a configured target. Two-phase: silent detection, then an interactive interview, then a proposed config for the user to approve.

## Inputs

- Target project path (required, passed by install.mjs).
- Target project's git remote, gh auth state, available GitHub Projects, existing labels, language and test-framework file hints.
- The user's live answers to the interview.

## Outputs

- `<target>/.claude/ops.config.json` (validated against the bundle's schema).
- `<target>/.claude/.bootstrap-answers.json` (transcript of the interview, gitignored).
- A short summary printed to stdout of what was detected, what the user chose, and the resulting config diff.

## Flow

1. **Detection phase** (read-only, prints a summary but does not ask yet):
   - `git remote get-url origin` to resolve owner/repo and default branch.
   - `gh auth status` and `gh api user` to capture the working login.
   - `gh project list --owner <owner> --format json` to discover Projects v2 in the org.
   - `gh api /repos/<owner>/<repo>/labels` to capture the existing label set.
   - File globs for language hints (`*.swift`, `Package.swift`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.kt`, `*.rs`, `*.rb`).
   - File globs for test-framework hints (`*UITests/*`, `playwright.config.*`, `pytest.ini`, `vitest.config.*`, `jest.config.*`, `go test` scripts).
   - File hints for dev organisation (`rollout.md`, `roadmap.md`, `.development/`, `.github/ISSUE_TEMPLATE/`).
2. **Interview phase** (8 topics, asked one at a time; the skill honours the user's answers over the detected defaults when they disagree):
   1. Work tracking style.
   2. Release cadence.
   3. Team size and push principals.
   4. e2e setup (framework and path).
   5. GitHub projects to observe (multi-select from discovered projects, with roles dev or release, plus optional observed repos).
   6. Observation depth per observed target (`full`, `umbrella-only`, `assigned-to-principals`, `labeled:<label>`, `issues-only`, `read-only`).
   7. Compliance context (regimes and data classes).
   8. Project-specific rules to seed (any domain rules the user wants materialised as `rules/product-*.md`).
3. **Compose phase**: build a candidate `ops.config.json` by merging detections with the user's answers. Fill defaults from the schema for anything not specified.
4. **Validate phase**: run the candidate through `scripts/lib/schema.mjs`. On failure, show the exact schema path that failed and ask the user to fix the corresponding answer; on success, proceed.
5. **Diff preview**: print the proposed config. User approves or edits.
6. **Write phase** (only on `--apply`): write the config file and the answers transcript. Never push to GitHub from this skill.

## Failure modes

- **gh not authed**: print `gh auth login` guidance with the required scopes (`repo, project, read:org, workflow`) and halt.
- **No git remote**: halt with a clear message; ask the user to configure the remote first.
- **Zero GitHub Projects discovered**: the interview still runs; the skill records empty `trackers.dev.projects[]` and (when the user opted into release umbrellas) `trackers.release.projects[]`, and warns that skills needing those lists will halt until the user points at real projects.
- **Schema validation fails after user confirmation**: halt and surface the failing path. Do not write a malformed config.
- **User declines to answer a required topic**: halt; the skill refuses to write a config with unresolved required keys.

## Cross-skill handoffs

- Called by `install.mjs` during the one-command install flow.
- Hands off to `install_memory_seeds.mjs` after writing the config, so seeds get filtered by the declared stack tags.
- Never calls `tracker-sync`, `dev-loop`, `release-tracker`, `regression-handler`, or `plan-keeper`.

## Idempotency

Running `bootstrap-ops-config` on a project that already has a valid `ops.config.json` is a no-op plus a message pointing at `adapt-system`. The skill never overwrites an existing config.

## Project contract

Reads (via the schema):

- `schemas/ops.config.schema.json` to validate its own output.
- Writes every top-level key of `ops.config.json`: `project`, `trackers`, `labels`, `workflow`, `paths`, `stack`, `area_keywords`, `compliance`.

Specific keys the interview asks the user about:

- `project.name`, `project.org`, `project.repo`, `project.default_branch`, `project.principals.push_allowed`, `project.principals.reviewers_default`
- `trackers.dev` (kind + kind-specific coordinates + projects/fields when GitHub), `trackers.release` (optional; omitted entirely when the user declines the release-umbrella question), `trackers.observed[]`
- `labels.type`, `labels.area`, `labels.priority`, `labels.intent`, `labels.size`, `labels.automation`, `labels.state_modifiers`
- `workflow.phase_term`, `workflow.pr.e2e_required_on`, `workflow.release.umbrella_title`, `workflow.code_review.provider`
- `paths.plans_root`, `paths.dev_working_dir`, `paths.reports`, `paths.runbooks`, `paths.templates`
- `stack.language`, `stack.testing`, `stack.platform`
- `area_keywords` (seeded from the user's choice of area labels; the user can extend here or via `adapt-system` later)
- `compliance.regimes`, `compliance.data_classes`
