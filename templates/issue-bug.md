<!--
agent-staff-engineer template: issue-bug.md
purpose: bug report, tracked as a dev issue
rendered by: tracker-sync.create_issue (type=bug) and regression-handler
ops.config keys read:
  - project.name
  - labels.type          (value "bug")
  - labels.area          (skill infers from area_keywords)
  - labels.priority      (defaults to p1-high unless overridden)
  - labels.size
  - labels.intent        (current intent if known)
  - stack.language       (to hint at reproduction environment)
  - stack.platform
  - workflow.phase_term
scalar placeholders:
  {{ project.name }}
  {{ title }}
  {{ summary }}
  {{ reproduction_steps }}        numbered list, one action per step
  {{ expected }}                  what should happen
  {{ observed }}                  what actually happens
  {{ first_seen }}                when the problem started, commit or date if known
  {{ environment_os }}
  {{ environment_platform }}      from stack.platform
  {{ environment_versions }}      runtime and dependency versions that matter
  {{ severity_note }}             one line describing blast radius
  {{ regression_candidate }}      optional #NNN linking the suspected origin issue
  {{ test_plan }}                 how fix will be verified and how we will prevent a repeat
block placeholders:
  <!-- agent:block regression_lookup_trail -->   only present when opened by regression-handler
notes:
  no em or en dashes. keep factual; blame is out of scope.
-->

## Summary

{{ summary }}

## Reproduction

{{ reproduction_steps }}

## Expected behaviour

{{ expected }}

## Observed behaviour

{{ observed }}

## Environment

- OS: {{ environment_os }}
- Platform: {{ environment_platform }}
- Versions: {{ environment_versions }}
- First seen: {{ first_seen }}

## Severity

{{ severity_note }}

## Regression check

- Candidate earlier issue: {{ regression_candidate }}

<!-- agent:block regression_lookup_trail -->

## Test plan for the fix

{{ test_plan }}
