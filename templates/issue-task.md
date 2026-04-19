<!--
agent-staff-engineer template: issue-task.md
purpose: small, well-scoped task that is not a feature, bug, refactor, or docs item
rendered by: tracker-sync issues.createIssue (type=task)
ops.config keys read:
  - project.name
  - labels.type          (value "task")
  - labels.area
  - labels.priority
  - labels.size
  - labels.intent
  - workflow.phase_term
scalar placeholders:
  {{ title }}
  {{ context }}                   why this task exists, one short paragraph
  {{ acceptance_criteria }}       bullets
  {{ dependencies }}              optional, list of #NNN or external links
  {{ test_plan }}                 how done is proven; "none" is a valid answer for configuration-only work
  {{ linked_release_ref }}
  {{ phase_term_pretty }}
notes:
  prefer tasks that are one PR or less. if it is bigger, use issue-feature.md instead.
  no em or en dashes.
-->

## Summary

{{ title }}

## Context

{{ context }}

## Acceptance criteria

{{ acceptance_criteria }}

## Dependencies

{{ dependencies }}

## Test plan

{{ test_plan }}

## Links

- {{ phase_term_pretty }} umbrella: {{ linked_release_ref }}
