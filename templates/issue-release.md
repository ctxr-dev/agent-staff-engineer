<!--
agent-staff-engineer template: issue-release.md
purpose: Release umbrella issue in the Release project (Project v2 role=release)
rendered by: tracker-sync issues.createIssue (type=release) and release-tracker
ops.config keys read:
  - project.name
  - labels.intent                  (this umbrella represents one intent value)
  - workflow.phase_term
  - workflow.release.umbrella_title
  - trackers.release.projects[].fields   (e.g. "Target Date", "Scope Tag", "Linked Dev Issues")
scalar placeholders:
  {{ project.name }}
  {{ intent_label_pretty }}        e.g. "Wave 1" derived from intent label "wave-1"
  {{ umbrella_goal }}              one short paragraph on what shipping this umbrella means
  {{ scope_tag }}                  single free-form tag, e.g. "app-store-launch" or "v1.2"
  {{ target_date }}                optional YYYY-MM-DD
  {{ non_goals }}                  bullets of what this umbrella explicitly does not cover
  {{ definition_of_done }}         bullets; tested, released, monitored, post-release checks
  {{ rollback_plan }}              how to pull this release if something burns
block placeholders (release-tracker maintains these, do not hand-edit):
  <!-- agent:block linked_dev_issues -->
  <!-- agent:block status_summary -->       (human-readable: n Done / n In review / n In progress / n Ready / n Backlog / n Blocked)
  <!-- agent:block blocker_list -->
notes:
  this issue is auto-moved through Backlog -> In progress -> Done by release-tracker.
  humans do not change its Status field by hand.
  a dev issue inside this umbrella only moves to Done by explicit human action.
  no em or en dashes.
-->

## {{ intent_label_pretty }} Release: {{ project.name }}

## Goal

{{ umbrella_goal }}

## Scope tag

{{ scope_tag }}

## Target date

{{ target_date }}

## Non-goals

{{ non_goals }}

## Definition of Done

{{ definition_of_done }}

## Rollback plan

{{ rollback_plan }}

## Linked dev issues

<!-- agent:block linked_dev_issues -->

## Current status summary

<!-- agent:block status_summary -->

## Blockers

<!-- agent:block blocker_list -->
