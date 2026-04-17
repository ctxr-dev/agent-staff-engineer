---
name: Dash-free writing
description: No em or en dashes in Claude-authored text on this project. Use commas, colons, parentheses, or line breaks.
type: feedback
portable: true
tags: []
placeholders: []
---

Never use the em dash (U+2014) or the en dash (U+2013) in any text authored on this project: issue bodies, PR descriptions, comments, reports, plan files, commit messages, memory entries. Hyphen (U+002D) inside identifiers and slugs is fine.

**Why:** consistency and a stated user preference. The rule is load-bearing enough that the bundle's `validate_bundle.mjs` greps for it, and `dev-loop` halts a PR open if the body contains a dash.

**How to apply:** before submitting any authored text, read it back. If the rhythm used a dash in the draft, rewrite the sentence. Preferred substitutes in order: comma, colon, parentheses, line break. See `rules/no-dashes.md` in the agent bundle for examples and edge cases (code fences, quoted user content, historical files being edited).
