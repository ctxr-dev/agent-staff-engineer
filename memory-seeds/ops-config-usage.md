---
name: Ops config usage
description: Before any workflow operation on this project, read .claude/ops.config.json. Cite the keys you used in any report.
type: feedback
portable: true
tags: []
placeholders:
  - "{{ project.repo }}"
---

Before any workflow operation on `{{ project.repo }}` (branch creation, PR open, issue create, label reconcile, release recompute, regression lookup, plan move), the first read is `.claude/ops.config.json`. Every project-specific decision the agent makes ties back to a key in that file, and any report the agent produces should cite the keys it relied on.

**Why:** the config is the contract between this project and the portable agent bundle. Behaviour that does not trace to a key in the config is un-auditable and breaks portability.

**How to apply:**

- First step of any skill: load `.claude/ops.config.json` and validate it against the bundle's schema.
- When halting or escalating, name the key: "The PR halted because `workflow.code_review.block_on_verdict` contained the reviewer verdict."
- When proposing a change, name the key the change would touch and whether it belongs in `ops.config.json` or in a project-specific file.
- If the config is missing or invalid, refuse to run and point at `bootstrap-ops-config`.
- If a configured key is missing in the live config, halt and ask rather than picking a default silently.

Configuration changes that reshape the project (new compliance, new stack, new target repo) go through `adapt-system`, not through hand-editing the config file.
