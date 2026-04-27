# Authoring CLAUDE.md as a compound-learning registry

> **Audience**: humans curating CLAUDE.md on a project that uses this bundle.
>
> **Why this guide exists**: convergent 2026 research finds that **human-curated CLAUDE.md raises agent success by ~4%**, while **AI-generated CLAUDE.md slightly reduces it (-1%)**. The difference is editorial: humans prune, agents accumulate. This guide describes what to put in CLAUDE.md, what to keep out, how to version it, and the registry pattern that lets the file accrete value over time.

## Purpose

CLAUDE.md is not a prompt dump. It is a **bulletin board** of distilled patterns that future agent runs benefit from on this specific repository: the codebase quirks, the recurring failure modes, the team standards that diverge from generic conventions. Read it once at session start; act on it for the rest of the run.

A good CLAUDE.md is short (one screen per section), specific (names files, links commits), and **versioned in git** so its growth is reviewable.

## What belongs in CLAUDE.md

Four sections cover the high-leverage cases:

1. **Project context.** Architecture overview, top-level layout, the one or two quirks every agent trips on. Keep to ~ 200 words.

2. **Compound learning -> Patterns that worked.** Distilled wins from past runs. One entry per worked pattern, with a status line, a first-seen date, a remediation pointer, and a next-review date. The registry template at `templates/claude-md/compound-learning.md` defines the exact shape.

3. **Compound learning -> Patterns that failed.** Equivalent shape; describes attempted approaches that were tried, surfaced a regression, and were reverted or replaced. Records the failure mode so agents stop re-trying the same dead-end.

4. **Compound learning -> Codebase quirks.** Non-obvious facts about this repo that an agent could not derive by reading the code: legacy branch policies, unusual build-system invariants, "if you touch X, also update Y" couplings. One-liner each.

Cross-references to deeper material are encouraged: link out to ADRs, runbooks, or canonical knowledge entries in the team wiki (`see: <paths.wiki>/knowledge/<domain>/<slug>.md`). CLAUDE.md is the bulletin board; the wiki is the archive.

## What does NOT belong

Reject anything in these buckets:

- **Generic coding standards.** Lives in the linter or formatter config; agents read those directly.
- **Ephemeral state.** Lives in `.claude/state/`. Per-session scratch belongs in a plan file or as a PR comment, never in CLAUDE.md.
- **Auto-generated content.** AI-summarised "what the codebase does" fails the +4% signal and reliably bloats the file. If you want a structural overview, write 100 careful words; do not paste an LLM dump.
- **Per-issue notes.** That is what issues, PRs, and commit messages are for. CLAUDE.md should outlast any single issue.
- **Anything in `.claude/ops.config.json`.** That file is the contract; CLAUDE.md must not duplicate it.

## Versioning and review cadence

CLAUDE.md is a markdown file in git. Treat it like documentation, not like memory:

- **Edit in PRs.** Every change is reviewable. Drive-by commits ("update CLAUDE.md after the auth migration") are encouraged.
- **Review every 20 to 30 agent runs**, or once per quarter, whichever comes first. Prune entries whose `next review` date has passed and whose remediation is now built into the codebase or the lint config.
- **Tag every entry with a `next review` date.** When the date passes, the entry is presumed stale until a human re-confirms it. The append helper at `scripts/lib/claude-md/append-entry.mjs` writes a default of "first seen + 6 months" when no explicit date is supplied.
- **Older than 6 months without review = remove or refresh.** Stale advice is worse than no advice.

## The compound-learning pattern

Every entry under "Patterns that worked" or "Patterns that failed" follows the registry shape. A worked example pulled from this bundle:

```markdown
### Pattern: PR iteration must cache bot node IDs per repo
- Status: worked
- First seen: 2026-04-10 in PR #123 (regression: bot-less request silently no-op'd).
- Remediation: capture bot ID once, store in iteration state. See `rules/pr-iteration.md`.
- Next review: 2026-10-10.
```

Four required fields: status, first seen, remediation, next review. Optional fields: linked issue or PR numbers, related canonical wiki entry, owner. The append helper enforces this shape.

## Anti-examples

- "Use clean code." (Generic; not actionable on this repo.)
- "We use TypeScript." (Derivable from `tsconfig.json`.)
- A 3 000-word architecture overview pasted in. (Auto-generated bloat; pull out the one or two actionable quirks instead.)
- An entry with no `next review` date. (Becomes stale invisibly.)
- A failure-mode entry with no remediation pointer. (Future agents will repeat the failure.)

## Seeding

`scripts/install.mjs` seeds CLAUDE.md on a fresh install with a registry stub: empty "Project context" placeholder plus the three "Patterns that worked / failed / Codebase quirks" headings. Existing CLAUDE.md content is preserved; the seeder merges only the registry section non-destructively. Re-running the installer is idempotent.

## How entries get added

Entries are appended via `scripts/lib/claude-md/append-entry.mjs`:

```bash
node scripts/lib/claude-md/append-entry.mjs \
  --path /path/to/project/CLAUDE.md \
  --section worked \
  --title "PR iteration must cache bot node IDs per repo" \
  --first-seen 2026-04-10 \
  --linked "PR #123" \
  --remediation "capture bot ID once; see rules/pr-iteration.md"
```

The helper is idempotent: re-running with the same `--title` updates the existing entry rather than duplicating it. A future `skills/knowledge-capture` integration will call this helper on accepted drafts so the registry grows without manual editing; today the entrypoint is the CLI.

## Relationship to the canonical knowledge store

CLAUDE.md is a **distillation** of the canonical knowledge store at `<paths.wiki>/knowledge/`:

- The wiki is the archive: detailed per-entity entries with strict frontmatter, agent-sourced but human-gated.
- CLAUDE.md is the bulletin board: ~ a page per section, human-curated, links out to wiki paths.

When you author a CLAUDE.md entry that summarises a wiki entry, link it: `see: <paths.wiki>/knowledge/patterns/pr-iteration-bot-id.md`. The bulletin-board entry is the one the agent reads at session start; the wiki entry is the one a teammate dives into when they want the full story.
