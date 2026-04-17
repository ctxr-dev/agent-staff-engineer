---
name: Plan lifecycle moves
description: Plans live under paths.plans_root and move through todo, in-progress, in-review, blocked, done. Only done is date-nested. No daily or knowledge writes.
type: feedback
portable: true
tags: []
placeholders:
  - "{{ paths.plans_root }}"
  - "{{ paths.done_pattern }}"
---

Plans on this project live under `{{ paths.plans_root }}`. Every actionable item in a plan is a GitHub-style checkbox. Plans move through lifecycle states one direction only.

**Why:** flat state folders keep the active work scannable; date-nested `done/` gives a natural historical view without cluttering the active lists. Consistent frontmatter and checkbox discipline lets the `plan-keeper` skill validate plans mechanically.

**How to apply:**

- Create new plans in `todo/`.
- Move to `in-progress/` when work begins. Update the `status` field in the plan's frontmatter.
- Route through `in-review/` while awaiting a human gate, or `blocked/` on external dependency.
- On explicit user confirmation of completion, move the plan to the date-nested done pattern: `{{ paths.done_pattern }}`. The date is the completion date, not the creation date.
- Normalise checkboxes on every move (no bare bullets for actionable items).
- Never infer "done" from a count of checked boxes. Only the user decides completion.

The agent does not write any plan-completion entry to a daily report or knowledge base. Those systems belong to the project and the agent stays out of them.
