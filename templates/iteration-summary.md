<!--
agent-staff-engineer template: iteration-summary.md
purpose: summary of one iteration, filed at the iteration's end
rendered by: plan-keeper.summarise_iteration (invoked on request)
stored at: {{ paths.reports }}/{{ iteration_end_date }}-iteration-{{ iteration_slug }}.md
ops.config keys read:
  - project.name
  - workflow.phase_term
  - github.dev_projects
  - paths.reports
  - labels.intent
  - labels.area
scalar placeholders:
  {{ project.name }}
  {{ iteration_label }}             human-readable iteration name
  {{ iteration_start_date }}        YYYY-MM-DD
  {{ iteration_end_date }}          YYYY-MM-DD
  {{ iteration_slug }}              kebab-case
  {{ phase_term_pretty }}           e.g. "Wave"
  {{ linked_release_ref }}          optional #NNN
  {{ headline }}                    one sentence of what shipped
  {{ risks_surfaced }}              bullets of new risks
  {{ lessons_learned }}             bullets that are worth carrying forward
  {{ next_iteration_prep }}         bullets; what to line up for the next iteration
block placeholders:
  <!-- agent:block items_done -->           dev issues closed during the iteration, grouped by area
  <!-- agent:block items_carried -->        dev issues that rolled over
  <!-- agent:block items_blocked -->        dev issues still blocked, with blocker notes
  <!-- agent:block pr_stats -->             PRs opened, merged, avg time-in-review
notes:
  this summary is a reflection, not a status report. keep it honest.
  no em or en dashes.
-->

# {{ iteration_label }}: {{ project.name }}

- **Dates**: {{ iteration_start_date }} to {{ iteration_end_date }}
- **{{ phase_term_pretty }} umbrella**: {{ linked_release_ref }}

## Headline

{{ headline }}

## Done this iteration

<!-- agent:block items_done -->

## Carried over

<!-- agent:block items_carried -->

## Blocked

<!-- agent:block items_blocked -->

## PR stats

<!-- agent:block pr_stats -->

## Risks surfaced

{{ risks_surfaced }}

## Lessons learned

{{ lessons_learned }}

## Prep for the next iteration

{{ next_iteration_prep }}
