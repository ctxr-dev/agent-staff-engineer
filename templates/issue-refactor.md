<!--
agent-staff-engineer template: issue-refactor.md
purpose: internal refactor with no intended behaviour change
rendered by: tracker-sync issues.createIssue (type=refactor)
ops.config keys read:
  - project.name
  - labels.type          (value "refactor")
  - labels.area
  - labels.priority
  - labels.size
  - labels.intent
  - workflow.phase_term
scalar placeholders:
  {{ title }}
  {{ motivation }}                why now, what pain it relieves
  {{ scope }}                     files, modules, boundaries touched
  {{ behaviour_preserved }}       explicit statement of what must not change
  {{ regression_risk }}           honest read on what could go wrong
  {{ rollback_plan }}             how to revert cleanly
  {{ acceptance_criteria }}       bullets including "no behavioural change visible to users or callers"
  {{ test_plan }}                 emphasise characterization tests and coverage of the changed surface
notes:
  behaviour change is out of scope. if the refactor reveals a bug, open a separate issue.
  no em or en dashes.
-->

## Summary

{{ title }}

## Motivation

{{ motivation }}

## Scope

{{ scope }}

## Behaviour to preserve

{{ behaviour_preserved }}

## Regression risk

{{ regression_risk }}

## Rollback plan

{{ rollback_plan }}

## Acceptance criteria

{{ acceptance_criteria }}

## Test plan

{{ test_plan }}
