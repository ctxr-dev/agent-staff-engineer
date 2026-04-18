---
name: Wiki scalable layout
description: Every wiki under .development/** uses the most nested, most scalable layout the llm-wiki skill supports. Flat date-prefixed siblings and hand-rolled versioned filenames are refused.
type: feedback
portable: true
tags: []
---

Every wiki the agent builds or writes into under `.development/{shared,local,cache}/**` uses the most nested, most scalable layout that `@ctxr/skill-llm-wiki` supports for the topic. Flat date-prefixed siblings (`2026-04-18-title.md` next to `2026-04-18-title-2.md` at a topic root) are a failure mode and refused. Hand-rolled versioned filenames (`foo.v1.md`, `foo-v2.md`, any user-visible `.vN` scheme) are also refused; history lives as git tags in `<wiki>/.llmwiki/git/`.

**Why:** flat siblings do not scale past a few dozen entries, defeat the wiki skill's router, and force every future reader to grep instead of navigate. Duplicating history as `.vN` siblings on top of the skill's built-in git history double-writes the same information and breaks retrieval.

**How to apply:**

- Dated topics (reports, regressions, postmortems, incident notes, session logs, anything that accretes over time): build the topic wiki in **hosted mode** with a `.llmwiki.layout.yaml` contract that sets `dynamic_subdirs.template: "{yyyy}/{mm}/{dd}"`. Leaves land at `<topic>/{yyyy}/{mm}/{dd}/<slug>.md`. Copy a starter contract from this bundle's `templates/llm-wiki-layouts/` rather than writing one from scratch.
- Subject topics (runbooks, playbooks, ADRs, domain notes): nest under descriptive category subfolders. Pick the category on the first write; never pile leaves at the topic root. Err on the side of nesting when two or more leaves share a defensible grouping.
- Before the first write to a topic that currently holds flat siblings, run `skill-llm-wiki fix` or `rebuild` with the correct contract dropped in so the shape is migrated first.
- Never write raw markdown under `.development/**` outside of a wiki the skill has built.
- When in doubt, re-read the canonical `@ctxr/skill-llm-wiki` SKILL.md and this project's `rules/llm-wiki.md`; those two files are the living spec.
