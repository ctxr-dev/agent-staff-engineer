---
name: no-dashes
description: Do not use em or en dashes in any Claude-authored text. Use commas, colons, parentheses, or line breaks. Applies universally. Not configurable.
portable: true
scope: every artefact the agent authors (issue bodies, PR descriptions, comments, reports, rules, seeds, templates, plan files)
---

# No em or en dashes

## The rule

Never use the em dash (U+2014) or the en dash (U+2013) in any text the agent writes. This covers issue bodies, PR descriptions, review comments, self-review reports, regression reports, plan files, templates, rules, memory seeds, and any markdown rendered to GitHub or the target filesystem.

Allowed substitutes, in order of preference:

1. Commas for mid-sentence pauses.
2. Colons when introducing a list or a clause.
3. Parentheses for side remarks.
4. Line breaks when the relationship between two clauses is better shown as two sentences.
5. Regular hyphens (U+002D) in compound identifiers and slugs (e.g. `feat/123-my-slug`).

## Why

- Consistency in tone. Em dashes in generated text are a reliable tell; their absence makes authored copy feel direct and edited.
- User preference, stated as a hard rule.
- Mechanically enforceable: grep catches every occurrence.

## How to apply

- Read back anything you wrote before submitting it. If you see U+2014 or U+2013 anywhere, rewrite the sentence.
- When rendering a template, check placeholder values the user supplied. If those carry dashes, surface the change for the user to accept rather than silently rewriting user copy.
- In headings and bullet lists, use a colon or a comma rather than a dash to introduce a phrase.

## Examples

```text
Bad:  This PR refactors the auth module — it splits the session logic into its own file.
Good: This PR refactors the auth module: it splits the session logic into its own file.

Bad:  Release Wave 1 — App Store Launch
Good: Release Wave 1: App Store Launch

Bad:  2026-04-17 – 2026-04-30
Good: 2026-04-17 to 2026-04-30
```

## Edge cases

- **Code snippets and identifiers**: dashes inside code fences, URLs, file paths, and accessibility IDs are preserved as-is. The rule applies to prose, not to executable content. `validate_bundle.mjs` excludes code fences from the grep.
- **User-supplied content**: if the user pastes a bug report with dashes, keep their dashes intact in the quoted section of the resulting issue. The agent's own authored surrounding text stays dash-free.
- **Historical files being edited**: when the agent edits an existing file, it may leave pre-existing dashes alone unless the file is declared canonical (rules, templates, memory seeds, anything the bundle ships).

## Not configurable

Unlike most rules in this bundle, the no-dashes rule is not gated by `ops.config.json`. It applies to every project that installs the agent. Projects that prefer different typography may fork the rule file in their own bundle copy, at which point they own the maintenance.

## Enforcement

- `scripts/validate_bundle.mjs` greps `rules/`, `templates/`, `memory-seeds/`, `skills/`, and fails the portability gate on any em or en dash outside a code fence.
- `dev-loop` checks the final PR body against the rule before pushing. A detected dash halts the open.

## Related rules

- [memory-hygiene.md](memory-hygiene.md): which mentions the dash-free writing seed.
- [pr-workflow.md](pr-workflow.md): enforces the rule at PR open time.
