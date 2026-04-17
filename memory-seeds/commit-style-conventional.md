---
name: Commit style
description: Conventional Commits with scope derived from the primary area label on the linked issue.
type: feedback
portable: true
tags: []
placeholders:
  - "{{ workflow.commits.style }}"
  - "{{ workflow.commits.scope_source }}"
  - "{{ workflow.commits.signed }}"
---

Commit messages follow the convention declared in `.claude/ops.config.json -> workflow.commits`.

Current settings for this project:

- **Style**: `{{ workflow.commits.style }}` (default is Conventional Commits).
- **Scope source**: `{{ workflow.commits.scope_source }}` (default derives scope from the primary `area/*` label on the linked issue).
- **Signed**: `{{ workflow.commits.signed }}`.

**Why:** consistent commit history drives automatic changelog generation and makes release notes scannable. Deriving scope from area labels keeps authorship consistent across contributors and sessions.

**How to apply:** when authoring a commit, look up the linked issue's `area/*` label and use it as the scope. Example shape: `feat(<area>): <summary>`. If the scope source is set to `manual`, prompt the user rather than guessing. Do not include the issue number in the commit subject; it goes in the PR body via `workflow.pr.link_issue_with`.
