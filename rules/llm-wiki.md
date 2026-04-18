---
name: llm-wiki
description: How the agent reads and writes docs under .development/**. Every topical subfolder is an in-place LLM wiki managed by @ctxr/skill-llm-wiki. This rule delegates all format and navigation questions back to that skill so the format lives in one place.
portable: true
scope: every session running on a project that installed this agent and has ops.config.json `wiki.required: true`
---

# LLM wiki

## The rule

Every topical subfolder under `.development/shared/`, `.development/local/`, and `.development/cache/` is its own **in-place LLM wiki**, managed by `@ctxr/skill-llm-wiki`. There is no sibling `.wiki/` folder; each topic directory IS its wiki.

The agent does not reimplement, reproduce, or summarise the wiki format in this rule. The **canonical spec for wiki format, placement, frontmatter, navigation, and operations lives in `@ctxr/skill-llm-wiki`'s own `SKILL.md`**. The agent re-reads that file every time it is about to read or write something under `.development/**`, and follows whatever the skill says today.

Why: the skill's format evolves on its own release cadence. Duplicating the rules here means drift the first time the skill ships a new frontmatter field or navigation rule.

## Scalable layout is non-negotiable

Every wiki the agent builds or writes into **must use the most nested, most scalable layout the skill supports for that topic**. Flat siblings of date-prefixed files (`2026-04-18-title.md`, `2026-04-18-title-2.md`, ...) are a failure mode, not a layout. They do not scale past a few dozen entries, they defeat the skill's router, and they force every future reader to grep instead of navigate. The agent refuses that shape and picks a nested structure on first write, not "later when there are enough files".

Concretely, before writing any leaf:

- For any topic whose entries accrete over time (reports, regressions, postmortems, incident notes, reviews, session logs, anything dated): use the skill's **hosted mode** with a `.llmwiki.layout.yaml` contract that defines `dynamic_subdirs.template: "{yyyy}/{mm}/{dd}"` (or the deepest template the volume justifies; `{yyyy}/{mm}` is acceptable for low-volume topics, never `{yyyy}-{mm}-{dd}` as a flat prefix). See the skill's `guide/layout/layout-contract.md` for the full template grammar.
- For topics whose entries group by subject (runbooks, playbooks, ADRs, domain notes): use descriptive category subfolders. Err on the side of nesting whenever two or more leaves share a defensible grouping; the skill's own guidance is the same (`SKILL.md`: "favour nesting over flatness... err on the side of nesting if in doubt"). Create the subcategory on write, do not pile into the topic root.
- Never use `.v1.md`, `.v2.md`, `-v2.md`, or any hand-rolled versioned filename scheme. The skill tracks history as git tags (`pre-op/<id>`, `op/<id>`) in the private repo at `<wiki>/.llmwiki/git/`. User-visible versioned siblings duplicate that and break the skill's router.

## Writing

Before persisting any doc under `.development/{shared,local,cache}/**`:

1. Read the canonical `@ctxr/skill-llm-wiki` SKILL.md. Its path is the `source:` field of the wrapper at `.claude/skills/agent-staff-engineer_llm-wiki.md` if one exists, or the installed location reported by `npx @ctxr/kit list`. On a standard install it sits at `~/.claude/skills/ctxr-skill-llm-wiki/SKILL.md` (never assume; read the wrapper to find the current path).
2. Identify the target topic wiki from `ops.config.json`:
   - Runbooks go under `wiki.roots.shared/runbooks/` by default. Nest by subject.
   - Reports go under `wiki.roots.shared/reports/` (this is what `workflow.code_review.report_dir` resolves to). Nest by date via `dynamic_subdirs.template: "{yyyy}/{mm}/{dd}"`.
   - Plans go under `wiki.roots.shared/plans/`. Nest by date via `{yyyy}/{mm}/{dd}`, or by subject category for long-running plan families.
   - For any other topic, pick a descriptive subfolder under the appropriate scope (`shared/` for team-visible, `local/` for per-user, `cache/` for regenerable), and pick a nesting scheme (date, subject, or both) before the first leaf is written.
3. If the target topic wiki does not yet exist (no `index.md`, no `.llmwiki/`), build it with the correct layout **before writing anything into it**:
   - Dated topics (reports, regressions, session logs, etc.): ship a `.llmwiki.layout.yaml` contract with `dynamic_subdirs.template: "{yyyy}/{mm}/{dd}"` and invoke `skill-llm-wiki build <topic-path> --layout-mode hosted --target <topic-path>` via a wiki-runner sub-agent. Templates for these contracts live under this bundle's `templates/llm-wiki-layouts/`; copy the closest match and edit, do not write from scratch.
   - Subject-categorised topics with no dated accrual: `--layout-mode in-place` is acceptable, but the agent still picks a category subfolder on the first write and grows the hierarchy from there.
4. Write the leaf directly into the topic wiki at the deepest valid path and with the frontmatter the skill's SKILL.md prescribes for the kind of doc you are writing. Do not invent a path or frontmatter shape; use what the skill documents. Do not pile leaves into the topic root when a subcategory or dated subpath applies.
5. Invoke whichever skill operation the SKILL.md names for "a leaf was just added". Typically that is:
   - `skill-llm-wiki validate <topic-path>` run inline (read-only, cheap) to detect index drift and flat-sibling regressions.
   - `skill-llm-wiki fix <topic-path>` or `rebuild` via a wiki-runner sub-agent when validate reports a mutating repair is needed, including when validate flags unnested siblings that should have been grouped.

The agent never writes raw markdown to `.development/**` outside of a wiki it has built, and never writes a leaf that would sit flat next to three or more peers when a nested home is available.

## Reading

Before reading anything under `.development/{shared,local,cache}/**`:

1. Read the canonical `@ctxr/skill-llm-wiki` SKILL.md for current navigation and retrieval guidance.
2. Follow the skill's guidance. The default flow is to enumerate the topic wikis under each scope, start from each topic's `index.md`, and route into leaves via frontmatter (`focus`, `covers`, `tags`, `parents`).
3. When a query spans more than one topic (e.g., a regression investigation that touches both `reports/` and `plans/`), use the skill's `Join` operation rather than grepping raw files.
4. `grep -r .development/` is a fallback only when the wiki is missing or `skill-llm-wiki validate` has failed on a given topic. In that case, surface the failure so the user can run `skill-llm-wiki fix` or `rebuild`; do not silently fall back and let the wiki rot.

## Skill discovery

The provider skill is declared in `ops.config.json -> wiki.provider`. When `wiki.required: true`, the installer refuses to apply if the skill is not installed. If the skill cannot be located at runtime (wrapper missing, uninstalled out of band), stop and tell the user to run `npx @ctxr/kit install @ctxr/skill-llm-wiki`. Do not silently write raw markdown bypassing the wiki.
