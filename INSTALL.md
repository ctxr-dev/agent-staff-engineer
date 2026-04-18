---
title: Installing agent-staff-engineer in a target project
status: finalised for v0.1.0
---

# Installing agent-staff-engineer

The recommended path is via [`@ctxr/kit`](https://github.com/ctxr-dev/kit). Manual install (git clone) is supported and the scripts self-locate wherever the bundle lives.

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI or IDE extension.
- **Node.js 20+**. The installer's preflight check enforces this and prints platform-specific install guidance on mismatch. Pass `--auto-install-node` to opt into a supported auto-install on macOS (Homebrew), Linux (nvm), or Windows (winget).
- **Git** installed and available on PATH.
- **GitHub CLI** (`gh`) authenticated with scopes `repo`, `project`, `read:org`, `workflow`. Verify with `gh auth status`.

## Required external skills

agent-staff-engineer depends on a separately-installed skill for docs routing:

- **`@ctxr/skill-llm-wiki`**: every doc under `.development/**` is managed as an in-place LLM wiki by this skill (runbooks, reports, plans). The installer will refuse to apply until this skill is present.

Install it via kit before running `install.mjs --apply`:

```bash
npx @ctxr/kit install @ctxr/skill-llm-wiki
```

Kit will place the skill under one of the following destinations (all satisfy the dep check):

- `~/.claude/skills/ctxr-skill-llm-wiki/` (user-global, with `--user`)
- `<project>/.claude/skills/ctxr-skill-llm-wiki/` (project-local, Claude-native)
- `<project>/.agents/skills/ctxr-skill-llm-wiki/` (project-local, open-standard parallel)

To opt out (you will manage `.development/` manually), set `wiki.required` to `false` in `ops.config.json`.

## Install via kit (recommended)

```bash
npx @ctxr/kit install @ctxr/agent-staff-engineer
```

Kit offers an interactive menu of candidate destinations:

- `.claude/agents/agent-staff-engineer/` (Claude Code's native discovery directory, project-scope)
- `.agents/agents/agent-staff-engineer/` (open-standard parallel, project-scope)
- `~/.claude/agents/agent-staff-engineer/` (user-global; pass `--user` to kit)
- Any custom path via `--dir <path>`

In non-interactive contexts (`CI=true`, piped stdin, or `--yes`) kit installs to the first existing project-scope candidate, or creates `.claude/agents/` if none exists.

The agent's scripts use `import.meta.url` to self-locate, so `bootstrap-ops-config` and `install.mjs` discover the bundle wherever kit placed it and record the actual path in `ops.config.json -> paths.agent_bundle_dir`.

## First run: self-bootstrap

After kit finishes, tell Claude to run the agent:

```text
Please run the agent-staff-engineer and set it up for this project.
```

On first run the agent:

1. Resolves its own install location.
2. Checks for `<project>/.claude/ops.config.json`. If absent, announces that it will bootstrap and invokes its own installer via the Bash tool.
3. The installer's preflight confirms Node 20+, then launches the interactive bootstrap interview (eight topics: work tracking, release cadence, team size and push principals, e2e setup, which GitHub projects to observe and at what depth, compliance context, project-specific rules to seed).
4. The installer writes `ops.config.json`, generates thin wrappers at `paths.wrappers.*` (default `.claude/skills/`, `.claude/rules/`, and the target's Claude memory folder), **prefixes every wrapper filename with the agent name** (derived from `package.json -> name`, so `@ctxr/agent-staff-engineer` becomes the prefix `agent-staff-engineer_`) to prevent collisions with other agents or skills, **injects a managed block into the project-level `CLAUDE.md`** (creates the file if missing; appends the block to any pre-existing user content; on update only the content between the two managed-block markers is refreshed), ensures `.development/` exists with `shared/` (committed), `local/` (gitignored), and `cache/` (gitignored) subtrees, and appends `local/` and `cache/` to `.gitignore` unless already present.
5. The agent hands control back, ready for your actual request.

## Manual install (without kit)

```bash
git clone https://github.com/ctxr-dev/agent-staff-engineer.git .claude/agents/agent-staff-engineer
node .claude/agents/agent-staff-engineer/scripts/install.mjs --target . --apply
```

Any destination works; the installer self-locates from `import.meta.url` and records the resolved path in `ops.config.json`. If you clone to `~/.claude/agents/agent-staff-engineer/` (user-global), the recorded `agent_bundle_dir` is the absolute path.

## Updating

Two modes, each appropriate for a different kind of change:

**Content-only update** (new rule wording, new memory-seed body, typo fix):

```bash
cd <bundle-dir>
git pull
```

Wrappers reference in-bundle paths, so the canonical content Claude reads refreshes on the next session. No reinstall needed.

**Structural update** (new skill, new rule, new memory seed, schema key):

```bash
node <bundle-dir>/scripts/install.mjs --target <project> --update
```

This regenerates only the **above-marker** section of every existing wrapper from current bundle state, adds fresh wrappers for new canonical files, and leaves everything **below the marker** byte-for-byte intact. Your project-specific overrides are preserved.

Orphaned wrappers (wrappers whose canonical source was removed in the update) are flagged with a warning inserted above the marker; they are never silently deleted, so your overrides on them are not lost.

## CLAUDE.md managed-block model

The project-level `CLAUDE.md` is handled differently from the other wrappers. Two delimiter lines are used:

```text
<!-- agent-staff-engineer:begin managed block ... -->
(agent-owned content, refreshed on install.mjs --update)
<!-- agent-staff-engineer:end managed block ... -->
```

- If `CLAUDE.md` does not exist, it is created containing only the managed block.
- If you already have a hand-written `CLAUDE.md`, the block is **appended at the end** of the file on first apply. Every byte above the block stays yours.
- `install.mjs --update` rewrites only the content between the markers. Anything outside (your preamble, your own sections below the block) is preserved byte-for-byte.
- On `install.mjs --uninstall`, the block is stripped. If nothing non-whitespace remains (you did not write any content outside the block), the file is deleted; otherwise the file is left in place without the block. A legacy `CLAUDE.agent.md` sidecar from an older install layout is migrated to `.userkeep.md` so you can inspect and fold in any edits.

If you manually remove the markers between installs, `--update` detects the absence and appends a fresh block rather than guessing. If you leave a dangling begin without an end, the installer refuses the injection and prints guidance; fix the markers (or delete the file) and re-run.

## Uninstall

```bash
node <bundle-dir>/scripts/install.mjs --target <project> --uninstall
```

The installer:

1. Reads the install manifest at `<target>/.claude/.<scoped-agent-slug>-install-manifest.json` (for this agent, `.ctxr-agent-staff-engineer-install-manifest.json`). A legacy generic `.install-manifest.json` from a pre-rename install is read as a fallback and removed on the next `--apply`/`--update`.
2. For each wrapper listed: if the below-marker section is empty, removes the wrapper. If it contains user content, preserves it as `<name>.userkeep.md` so your overrides survive the uninstall.
3. Removes the manifest.
4. Leaves `ops.config.json`, any `rules/product-*.md`, and the `.development/` folder (including `shared/` committed content) untouched. Those belong to your project, not the agent.

To remove the bundle folder itself:

```bash
rm -rf <bundle-dir>
```

## Adaptation (after install)

When your project changes shape, use the adapt-system skill. From a Claude Code session:

```text
adapt-system: we handle PHI now
```

The agent parses the intent, loads the current state, produces a unified diff across `ops.config.json`, label plans, template sections, proposed new product rules, and memory-seed installs. You approve the diff; the skill applies the file changes and, if needed, calls `github-sync` to reconcile labels.

Idempotent: re-running with the same intent is a no-op. Contradictory intents ("we dropped X") produce removal diffs and flag any open GitHub issues that carry the affected labels.

## Known stacks (seed activation)

Some memory seeds are tagged to stack-specific contexts. Seeds install only when every tag matches the declared `ops.config.json -> stack.*`:

- `swift-dst-day-count.md`: tag `language: swift`
- `xcui-combined-a11y.md`: tags `language: swift`, `testing: xcuitest`

Every other seed is untagged and installs on every project.

## Troubleshooting

- **gh not authed / missing scopes**: bootstrap halts with `gh auth status` guidance. Fix and re-run the agent.
- **No git remote detected**: bootstrap halts. Initialise the remote first.
- **Schema validation fails after your answers**: the installer points at the exact key that failed; correct your answer and re-run the bootstrap prompt.
- **Node too old**: preflight exits with platform-specific install guidance. Use `--auto-install-node` if you trust it for your platform.
- **Wrapper lost its marker** (you edited the wrapper above the marker and wiped the line accidentally): the installer detects the missing marker and refuses to update that wrapper, pointing at the edit. Move your changes below the marker and re-run `--update`.

## See also

- [README.md](README.md) for a shorter overview.
- [CONTRIBUTING.md](CONTRIBUTING.md) for the authoring workflow.
- [design/ARCHITECTURE.md](design/ARCHITECTURE.md) for the skill composition, bootstrap flow, update flow, and uninstall flow diagrams; the single authoritative architecture reference.
- [schemas/ops.config.schema.json](schemas/ops.config.schema.json) is the living contract with per-field descriptions and defaults.
