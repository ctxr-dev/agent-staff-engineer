---
title: agent-staff-engineer
version: 0.1.0
status: build + test complete; ready for first kit install
---

# agent-staff-engineer

[![npm](https://img.shields.io/npm/v/@ctxr/agent-staff-engineer)](https://www.npmjs.com/package/@ctxr/agent-staff-engineer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A portable, adaptive Claude Code agent that acts as a staff engineer for any project. GitHub Issues + Projects are the single source of truth. The agent drives the full dev loop (branch, code, local review, self-review, PR open, reviewer requests, status sync up to In review) and reserves exactly two gates for you: **PR merge** and **dev-issue Done**.

## Quick start (via @ctxr/kit)

```bash
# 1. Install the agent. Kit offers an interactive menu for the destination:
#    .claude/agents/, .agents/agents/, ~/.claude/agents/, or a custom --dir.
npx @ctxr/kit install @ctxr/agent-staff-engineer
```

Then in Claude Code, ask Claude to run the agent, for example:

```text
Run the agent-staff-engineer and help me set it up for this project.
```

On first run, the agent detects that `.claude/ops.config.json` is missing and self-bootstraps: it runs its own installer, launches an interactive interview (work tracking style, release cadence, e2e setup, which GitHub projects to observe and at what depth, compliance context), writes `ops.config.json`, generates thin wrapper files at the canonical Claude Code locations, and hands control back.

On every later invocation the agent acts on your request directly, guided by the configured rules.

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI or IDE extension.
- **Node.js 20+** (preflight enforces this and offers platform-specific install guidance on mismatch).
- **Git** (for the bundle repo + dev loop operations).
- **GitHub CLI** (`gh`) authed with scopes `repo`, `project`, `read:org`, `workflow`.

## What you get

- **Installable via kit.** One command places the bundle; one more (or just "run the agent") bootstraps it.
- **Wrapper model**: canonical skills, rules, and memory seeds stay inside the bundle folder. The installer writes thin wrappers at `.claude/skills/agent-staff-engineer_<name>/SKILL.md`, `.claude/rules/agent-staff-engineer_<name>.md`, and `.claude/memory/seed-agent-staff-engineer_<name>.md`. The agent-name prefix is derived from `package.json -> name` so wrappers never collide with files shipped by other agents or skills. Each wrapper points at the canonical file and has a marker line; anything you add below the marker survives every update.
- **Auto-update via `git pull`** inside the bundle folder. Wrappers reference stable in-bundle paths, so content updates take effect immediately. Run `install.mjs --update` only when the canonical file set or schema changes.
- **Interactive bootstrap** asks the right questions; user input wins over heuristic detections.
- **Continuous adaptation**: the `adapt-system` skill takes free-form user intent ("we handle PHI now", "we added a Chrome extension target", "dropped the legacy analytics SDK") and produces cascading diffs across config, labels, templates, rules, and memory seeds. Idempotent, diff-previewed, never silent.
- **Multi-target GitHub observation**: the config supports multiple dev projects, multiple release projects, and additional watched repos, each with its own depth setting (`full`, `umbrella-only`, `assigned-to-principals`, `labeled:X`, `issues-only`, `read-only`).
- **Code review default**: the `dev-loop` skill delegates self-review to [`@ctxr/skill-code-review`](https://github.com/ctxr-dev/skill-code-review) (up to 18 specialist reviewers, GO / CONDITIONAL / NO-GO verdict). Configurable; falls back to an internal template on projects that have not installed the external skill.

## Hard rules the agent never breaks

- GitHub is the source of truth. Local files are projections.
- The agent **never merges a PR**. Merge belongs to you.
- The agent **never sets a dev issue to Done**. Done belongs to you.
- No em or en dashes in any Claude-authored text. Use commas, colons, parentheses, or line breaks.
- The agent does not touch `daily/` or `knowledge/` folders. Those belong to the project's own hooks.

## Manual install (without kit)

```bash
git clone https://github.com/ctxr-dev/agent-staff-engineer.git .claude/agents/agent-staff-engineer
node .claude/agents/agent-staff-engineer/scripts/install.mjs --target . --apply
```

The scripts self-locate via `import.meta.url`, so they work regardless of where kit or you placed the bundle.

## Structure

- `AGENT.md`: Claude Code agent entry point with self-bootstrap instructions.
- `skills/`: seven workflow skills (bootstrap-ops-config, adapt-system, github-sync, dev-loop, release-tracker, regression-handler, plan-keeper).
- `rules/`: seven portable process rules (GitHub as truth, PR workflow, no dashes, plan management, review loop, memory hygiene, adaptation).
- `memory-seeds/`: eight starter memory entries, stack-tag filtered at install time.
- `templates/`: ten issue / PR / report templates with `{{ placeholder }}` substitution.
- `schemas/ops.config.schema.json`: strict JSON Schema validated on every install.
- `scripts/`: Node.js ESM installer, bootstrap, adapt, seed installer, validator, preflight, update_self, plus shared helpers under `scripts/lib/` (agentName, fsx, gitignore, inject, schema, wrapper, diff, argv, ghExec).
- `examples/`: fully-populated fictitious example config.
- `tests/`: `node:test` unit + E2E.
- `design/`: MASTER-PLAN, DECISIONS, ARCHITECTURE, OPEN-QUESTIONS, RISKS.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add skills, rules, or seeds. See [INSTALL.md](INSTALL.md) for the full install reference including update and uninstall.
