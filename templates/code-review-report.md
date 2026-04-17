<!--
agent-staff-engineer template: code-review-report.md
purpose: FALLBACK self-review template. Only used when workflow.code_review.provider
         is set to "internal-template".
         Default provider is ctxr-dev/skill-code-review
         (https://github.com/ctxr-dev/skill-code-review), which dispatches up to 18
         specialist reviewers in parallel and produces its own structured report
         with a GO / CONDITIONAL / NO-GO verdict. Prefer it unless a project
         explicitly opts out via ops.config.json -> workflow.code_review.provider.
rendered by: dev-loop.self_review (fallback path)
stored at: {{ workflow.code_review.report_dir }}/{{ date }}-{{ issue_number }}-self-review.md
ops.config keys read:
  - project.name
  - workflow.code_review.report_dir
  - workflow.pr.tests_required
  - workflow.pr.e2e_required_on
  - stack.language
  - stack.testing
scalar placeholders:
  {{ date }}                       YYYY-MM-DD
  {{ issue_number }}               the dev issue this PR addresses
  {{ author }}
  {{ branch }}
  {{ diff_stats_summary }}         e.g. "12 files changed, +420, -180"
  {{ commit_count }}
  {{ behavioural_changes }}        bullets of user or caller visible changes
  {{ non_behavioural_changes }}    bullets of refactors and internal shifts
  {{ test_coverage_notes }}        per test category, what was added or why skipped
  {{ risk_assessment }}            honest paragraph
  {{ alternatives_considered }}    optional, a bullet list
  {{ outstanding_concerns }}       items the author wants reviewers to weigh in on
  {{ dependencies }}               optional; external changes this PR relies on
block placeholders:
  <!-- agent:block files_changed -->           a rendered tree of changed files
  <!-- agent:block test_results -->            local test run summaries per required category
notes:
  this report is an artefact, not a rubber stamp. honest reads of risk are the point.
  no em or en dashes.
-->

# Self-review report

- **Project**: {{ project.name }}
- **Issue**: #{{ issue_number }}
- **Author**: {{ author }}
- **Branch**: {{ branch }}
- **Date**: {{ date }}
- **Diff stats**: {{ diff_stats_summary }}, across {{ commit_count }} commits

## Files changed

<!-- agent:block files_changed -->

## Behavioural changes

{{ behavioural_changes }}

## Non-behavioural changes

{{ non_behavioural_changes }}

## Test coverage

{{ test_coverage_notes }}

<!-- agent:block test_results -->

## Risk assessment

{{ risk_assessment }}

## Alternatives considered

{{ alternatives_considered }}

## Outstanding concerns for reviewers

{{ outstanding_concerns }}

## Dependencies

{{ dependencies }}
