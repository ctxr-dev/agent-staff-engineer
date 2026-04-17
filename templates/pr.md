<!--
agent-staff-engineer template: pr.md
purpose: pull request body
rendered by: dev-loop.open_pr
ops.config keys read:
  - project.name
  - project.default_branch
  - workflow.pr.title
  - workflow.pr.link_issue_with     (e.g. "Closes #{issue}")
  - workflow.pr.request_reviewers
  - workflow.pr.tests_required
  - workflow.pr.e2e_required_on
  - workflow.pr.self_review_required
  - workflow.pr.link_release_umbrella
  - paths.reports                    (where self-review lives)
scalar placeholders:
  {{ project.name }}
  {{ issue_number }}                 the dev issue this PR closes
  {{ issue_title }}
  {{ summary }}                      one paragraph, what this change does and why
  {{ what_changed }}                 bullets of concrete changes, at file or module granularity
  {{ test_plan }}                    bullets covering the required test categories
  {{ risk }}                         honest risk read
  {{ rollback }}                     how to revert cleanly
  {{ self_review_path }}             path to the self-review report filed under paths.reports
  {{ release_umbrella_ref }}         optional #NNN of the linked Release umbrella
  {{ screenshots }}                  optional; inserted as markdown images or "none"
  {{ author }}
  {{ reviewers }}                    joined list, as a human-readable string
block placeholders (skill inserts):
  <!-- agent:block checklist -->     the ready-for-review checklist, per workflow.pr.* flags
notes:
  no em or en dashes.
  the bottom-line issue link is the only way the PR closes the dev issue.
  the agent does not merge. a human merges, then a human marks the dev issue Done.
-->

## Summary

{{ summary }}

## What changed

{{ what_changed }}

## Test plan

{{ test_plan }}

## Screenshots or recordings

{{ screenshots }}

## Risk

{{ risk }}

## Rollback

{{ rollback }}

## Links

- Dev issue: #{{ issue_number }} ({{ issue_title }})
- Release umbrella: {{ release_umbrella_ref }}
- Self-review report: [{{ self_review_path }}]({{ self_review_path }})

## Ready-for-review checklist

<!-- agent:block checklist -->

---

{{ workflow.pr.link_issue_with }}

Requested reviewers: {{ reviewers }}

cc @{{ author }}
