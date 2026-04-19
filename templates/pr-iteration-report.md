<!--
agent-staff-engineer template: pr-iteration-report.md
purpose: Per-round artefact written by skills/pr-iteration every time the
         PR iteration loop completes a round (request external review -> poll
         -> fetch threads -> triage -> fix + push + resolve -> re-request).
         One file per PR, appended in reverse-chronological order as new
         rounds land, OR one file per round: the wiki's own SKILL.md (at
         @ctxr/skill-llm-wiki) decides placement and stitching; this
         template is the content shape.
rendered by: skills/pr-iteration (via rules/llm-wiki.md; writes go through
         @ctxr/skill-llm-wiki, not raw markdown into shared/)
stored at: resolved under {{ workflow.code_review.report_dir }} (which
         resolves under wiki.roots.shared/reports/ by default) per the
         wiki skill's placement rules; DO NOT hard-code a path.
ops.config keys read:
  - project.name
  - project.repo
  - workflow.external_review.poll_interval_seconds
  - workflow.external_review.poll_timeout_seconds
  - workflow.external_review.auto_resolve_stale_after_commits
  - trackers.dev.kind               (PR 3+; falls back to "github" pre-PR-3)
scalar placeholders:
  {{ date }}                        YYYY-MM-DD
  {{ round_number }}                1-based integer
  {{ pr_number }}                   PR/MR number on the tracker
  {{ previous_head_sha }}           SHA HEAD was at when this round began
  {{ new_head_sha }}                SHA HEAD is at after this round's commit
  {{ tracker_kind }}                github | jira | linear | gitlab
  {{ reviewer_logins }}             comma-separated logins from requestReview response
  {{ ci_state }}                    SUCCESS | FAILURE | ERROR | PENDING
  {{ unresolved_count }}            threads left unresolved at poll-exit
  {{ review_on_head }}              true/false (was a review posted on new_head_sha?)
  {{ round_elapsed_seconds }}       wall-clock seconds this round consumed
  {{ exit_gate_local_go }}          true/false (rules/review-loop.md result on new_head_sha)
  {{ exit_gate_zero_unresolved }}   true/false
  {{ exit_gate_ci_success }}        true/false
  {{ all_gates_hold }}              true/false (final exit condition)
list placeholders:
  {{ threads_resolved }}            [{id, path:line, bucket, justification}]
  {{ threads_flagged_stale }}       [{id, path:line, fingerprint}]
  {{ threads_deferred }}            [{id, path:line, reason}]
  {{ commits_in_round }}            [{sha, title}]
notes:
  - Every bulleted list below MUST render with exactly the items the loop
    produced; empty categories render as "(none)". Do not omit the heading.
  - The "Exit conditions" table is the machine-readable hand-off; a human
    (or another skill) scans this table to decide whether to merge.
-->

# pr-iteration report round {{ round_number }} for PR #{{ pr_number }}

**Date:** {{ date }}  **Tracker:** {{ tracker_kind }}  **Project:** {{ project.name }} ({{ project.repo }})

- Previous HEAD: `{{ previous_head_sha }}`
- New HEAD: `{{ new_head_sha }}`
- Reviewer(s) requested: {{ reviewer_logins }}
- Round elapsed: {{ round_elapsed_seconds }}s

## Poll result at round exit

| CI state | Unresolved threads | Review on HEAD |
|---|---|---|
| {{ ci_state }} | {{ unresolved_count }} | {{ review_on_head }} |

## Threads

### Resolved

{{ threads_resolved }}

### Flagged stale (no code change; auto-resolve after `auto_resolve_stale_after_commits` recurrences)

{{ threads_flagged_stale }}

### Deferred (needs human decision)

{{ threads_deferred }}

## Commits in this round

{{ commits_in_round }}

## Exit conditions

| Gate | Status |
|---|---|
| Local review GO on current HEAD (`rules/review-loop.md`) | {{ exit_gate_local_go }} |
| Zero unresolved threads on HEAD + review on HEAD SHA | {{ exit_gate_zero_unresolved }} |
| CI `SUCCESS` on HEAD | {{ exit_gate_ci_success }} |
| **All three hold** | **{{ all_gates_hold }}** |

When `all_gates_hold` is true, the loop stops. PR merge is a human gate; the agent never crosses it.
