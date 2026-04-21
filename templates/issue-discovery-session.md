<!--
agent-staff-engineer template: issue-discovery-session.md
purpose: human-readable render of a session scratch file under .development/local/issue-discovery/
rendered by: issue-discovery skill (on "show me the session" request)
ops.config keys read:
  - trackers.dev[]                        to name the target project
  - workspace.members[]                   to resolve memberName, if any
  - workflow.issue_discovery.*            optional overrides on the intake
  - paths.plans_root                      only referenced via plan-keeper when plan stubs are enabled

The rest of the bundle's templates use plain `{{ key }}` substitution with no control flow. This template follows the same convention: all conditionals are resolved by the caller, which pre-renders the appropriate string for each placeholder (including "none" fallbacks for absent sections). The caller concatenates the full document, not this template file line-by-line.

scalar placeholders:
  {{ session_id }}                        session identifier (YYYYMMDD-HHMMSS-<4 hex>)
  {{ started_at }}                        ISO-8601 session start timestamp
  {{ status }}                            pending | completed | cancelled | timed-out (see scripts/lib/issueDiscovery.mjs#archiveSession for the authoritative outcome list)
  {{ tracker_target }}                    short tracker coords, e.g. ctxr-dev/agent-staff-engineer
  {{ member_suffix }}                     " (member: `libs/shared`)" or "" when no workspace member
  {{ current_step }}                      active node id (q0, q1, ..., q6, done)
  {{ intent_text }}                       the user's first-message intent, verbatim
  {{ next_action }}                       one-line description of what the skill will do next
  {{ answers_block }}                     pre-rendered bullet list of recorded node answers
  {{ proposed_payload_block }}            pre-rendered "## Proposed issue payload" section or empty
  {{ umbrella_decision_block }}           pre-rendered "## Umbrella decision" section or empty
-->

# Issue discovery session `{{ session_id }}`

Human-readable rendering of a session scratch file under `.development/local/issue-discovery/`. The canonical state is the JSON; this template is what the agent prints when asked to show the session. Archived sessions live at the same path under a `<session-id>.<outcome>.json` suffix (outcomes: `completed`, `cancelled`, `timed-out`; see `scripts/lib/issueDiscovery.mjs#archiveSession` for the authoritative list). The template is agnostic to the filename.

- **Started:** {{ started_at }}
- **Status:** `{{ status }}`
- **Target project:** {{ tracker_target }}{{ member_suffix }}
- **Current step:** `{{ current_step }}`
- **Topic:** {{ intent_text }}

## Decisions recorded so far

{{ answers_block }}

{{ proposed_payload_block }}

{{ umbrella_decision_block }}

## Next action

- `{{ next_action }}`

---

This is a rendering of session scratch state, not durable config. Archival on terminal outcomes uses `<session-id>.<outcome>.json` where `<outcome>` is one of the documented terminal statuses (`completed` on a Q6 Proceed, `cancelled` on a Q6 Cancel, `timed-out` once the PR 14 session-resume rule lands). No archive path promotes to `ops.config.json` or to persistent memory.
