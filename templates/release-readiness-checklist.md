<!--
agent-staff-engineer template: release-readiness-checklist.md
purpose: checklist filed against a Release umbrella when it is ready to ship
rendered by: release-tracker.produce_readiness_checklist (invoked by user before moving umbrella to Done)
stored at: {{ paths.reports }}/{{ date }}-release-readiness-{{ scope_tag }}.md
ops.config keys read:
  - project.name
  - workflow.phase_term
  - workflow.pr.e2e_required_on
  - workflow.pr.tests_required
  - labels.intent
  - trackers.release.projects
  - paths.reports
scalar placeholders:
  {{ date }}
  {{ project.name }}
  {{ intent_label_pretty }}        e.g. "Wave 1"
  {{ scope_tag }}                  e.g. "v1.2" or "app-store-launch"
  {{ target_date }}
  {{ release_umbrella_ref }}       #NNN of the umbrella issue
  {{ release_manager }}            human accountable for the release
  {{ monitoring_plan }}            what to watch after ship
  {{ rollback_plan }}              concrete steps to revert
  {{ sign_off_owner }}             who signs the ship decision
block placeholders:
  <!-- agent:block dev_issues_status -->       table of linked dev issues and their status
  <!-- agent:block test_suite_status -->       per category: unit, integration, e2e (from workflow.pr.tests_required and e2e_required_on)
  <!-- agent:block dependency_check -->        upstream dependencies green, schema migrations applied, flags set
notes:
  release-tracker does not move the umbrella to Done. a human does, after reviewing this checklist.
  no em or en dashes.
-->

# Release readiness: {{ intent_label_pretty }} of {{ project.name }}

- **Scope tag**: {{ scope_tag }}
- **Target date**: {{ target_date }}
- **Release umbrella**: {{ release_umbrella_ref }}
- **Release manager**: {{ release_manager }}
- **Sign-off owner**: {{ sign_off_owner }}
- **Date of this checklist**: {{ date }}

## Dev issues

<!-- agent:block dev_issues_status -->

Every dev issue listed must be Done (human-confirmed) before the umbrella moves to Done.

## Test suite status

<!-- agent:block test_suite_status -->

## Dependencies

<!-- agent:block dependency_check -->

## Monitoring plan

{{ monitoring_plan }}

## Rollback plan

{{ rollback_plan }}

## Final sign-off

- [ ] All dev issues Done.
- [ ] All required test categories green.
- [ ] Dependencies green.
- [ ] Monitoring in place.
- [ ] Rollback tested or dry-run reviewed.
- [ ] Release manager approves.
- [ ] {{ sign_off_owner }} approves.
