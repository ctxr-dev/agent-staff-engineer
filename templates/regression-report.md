<!--
agent-staff-engineer template: regression-report.md
purpose: attached to a bug issue when regression-handler triages a user-reported regression
rendered by: regression-handler.triage
stored at: {{ paths.reports }}/{{ date }}-regression-{{ bug_issue_number }}.md and attached as a comment on the bug issue
ops.config keys read:
  - project.name
  - labels.area
  - labels.priority
  - labels.automation           (applies auto-regression label)
  - area_keywords
  - github.dev_projects
  - github.observed_repos
scalar placeholders:
  {{ date }}
  {{ bug_issue_number }}
  {{ bug_title }}
  {{ reporter }}                      who raised the regression
  {{ suspected_origin_issue }}        #NNN of the issue the lookup settled on, or "none"
  {{ suspected_origin_pr }}           #NNN of the PR that likely introduced it, or "none"
  {{ suspected_commit }}              SHA or "unknown"
  {{ matched_area }}                  area label matched by keyword search
  {{ severity_read }}                 one-line severity assessment
  {{ proposed_remediation }}          bullets; reopen, reassign, new fix issue, further investigation
  {{ owner_proposed }}                who should own the fix
block placeholders:
  <!-- agent:block lookup_trail -->          ordered list: file-path match, area-label match, title-keyword match, repo scan results
  <!-- agent:block evidence_links -->        links to matching closed issues, PRs, commits, log lines if available
notes:
  this report is the paper trail for why a regression was classified the way it was.
  the skill never reopens an issue or creates one silently; every action here is proposed and the user confirms.
  no em or en dashes.
-->

# Regression triage report

- **Project**: {{ project.name }}
- **Bug issue**: #{{ bug_issue_number }} ({{ bug_title }})
- **Reporter**: {{ reporter }}
- **Date**: {{ date }}

## Lookup trail

<!-- agent:block lookup_trail -->

## Evidence

<!-- agent:block evidence_links -->

## Best match

- Suspected origin issue: {{ suspected_origin_issue }}
- Suspected origin PR: {{ suspected_origin_pr }}
- Suspected commit: {{ suspected_commit }}
- Area label matched: {{ matched_area }}

## Severity read

{{ severity_read }}

## Proposed remediation

{{ proposed_remediation }}

## Suggested owner

{{ owner_proposed }}
