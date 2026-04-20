<!--
agent-staff-engineer template: issue-feature.md
purpose: new feature proposal, tracked as a dev issue
rendered by: tracker-sync issues.createIssue (type=feature)
ops.config keys read:
  - project.name
  - labels.type          (value "feature")
  - labels.area          (user or skill picks one or more)
  - labels.priority      (user or skill picks one)
  - labels.size          (user or skill picks one)
  - labels.intent        (user or skill picks one)
  - workflow.phase_term  (used in label naming and copy)
scalar placeholders:
  {{ project.name }}              project short name
  {{ title }}                     one-line feature title
  {{ user_value }}                who benefits and why it matters
  {{ acceptance_criteria }}       bullet list, one line each
  {{ non_goals }}                 optional, bullets of what is explicitly out of scope
  {{ risks }}                     optional, bullets of risks and open questions
  {{ test_plan }}                 bullets describing how this will be verified
  {{ linked_release_ref }}        optional, #NNN of the linked Release umbrella
  {{ phase_term_pretty }}         "Wave", "Track", or whatever is configured
block placeholders (skill inserts):
  <!-- agent:block area_keywords_hint -->
notes:
  keep this short and direct. no em or en dashes.
-->

## Summary

{{ title }}

## Why this matters

{{ user_value }}

## Acceptance criteria

{{ acceptance_criteria }}

## Non-goals

{{ non_goals }}

## Risks and open questions

{{ risks }}

## Test plan

{{ test_plan }}

## Links

- {{ phase_term_pretty }} umbrella: {{ linked_release_ref }}

<!-- agent:block area_keywords_hint -->
