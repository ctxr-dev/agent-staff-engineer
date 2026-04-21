<!--
agent-staff-engineer template: issue-discovery-session.md
purpose: human-readable render of a session scratch file under .development/local/issue-discovery/
rendered by: issue-discovery skill (on "show me the session" request)
ops.config keys read:
  - trackers.dev[]                        to name the target project
  - workspace.members[]                   to resolve memberName, if any
  - workflow.issue_discovery.*            optional overrides on the intake
  - paths.plans_root                      only referenced via plan-keeper when plan stubs are enabled
scalar placeholders:
  {{ session_id }}                        session identifier (YYYYMMDD-HHMMSS-slug)
  {{ started_at }}                        ISO-8601 session start timestamp
  {{ status }}                            pending | completed | cancelled
  {{ tracker_target }}                    short tracker coords, e.g. ctxr-dev/agent-staff-engineer
  {{ member_name }}                       workspace member name (or empty)
  {{ current_step }}                      active node id (q0, q1, ..., q6, done)
  {{ intent_text }}                       the user's first-message intent, verbatim
  {{ next_action }}                       one-line description of what the skill will do next
list placeholders:
  {{ answers[] }}                         ordered node answers (nodeId + short summary)
object placeholders:
  {{ proposed_payload }}                  assembled Q3 payload (title/type/labels/priority/size/acceptance)
  {{ umbrella_decision }}                 the Q4-Q5 outcome (kind, optional ref, optional payload)
-->

# Issue discovery session `{{session_id}}`

Human-readable rendering of a session scratch file under `.development/local/issue-discovery/{{session_id}}.json`. The canonical state is the JSON; this template is what the agent prints when asked to show the session.

- **Started:** {{started_at}}
- **Target project:** {{tracker_target}} {{#member_name}}(member: `{{member_name}}`){{/member_name}}
- **Current step:** `{{current_step}}`
- **Topic:** {{intent_text}}

## Decisions recorded so far

One bullet per recorded answer, rendered over the `{{answers}}` array.

- **{{node_id}}**: {{answer_summary}}

## Proposed issue payload

Present only when the interview has reached at least Q3f.

- Title: {{proposed_payload.title}}
- Type: `{{proposed_payload.type}}`
- Labels: {{proposed_payload.labels_csv}}
- Priority: `{{proposed_payload.priority}}`
- Size: `{{proposed_payload.size}}`
- Acceptance criteria: {{proposed_payload.acceptance_criteria_or_exploratory}}

## Umbrella decision

Present only when the interview has reached at least Q4a or Q4c. `kind` is one of `skip`, `link-existing`, or `create-new`.

- Kind: `{{umbrella_decision.kind}}`
- Linked umbrella: {{umbrella_decision.ref_or_none}}
- Intent: `{{umbrella_decision.payload.intent_or_none}}`
- Goal: {{umbrella_decision.payload.goal_or_none}}
- Target date: {{umbrella_decision.payload.target_date_or_none}}
- Non-goals: {{umbrella_decision.payload.non_goals_csv_or_none}}
- Definition of Done: {{umbrella_decision.payload.definition_of_done_csv_or_none}}
- Rollback plan: {{umbrella_decision.payload.rollback_plan_or_none}}
- Stakeholders: {{umbrella_decision.payload.stakeholders_csv_or_none}}

## Next action

- `{{next_action}}`

---

This is a rendering of session scratch state, not durable config. Archival on terminal nodes: `<session-id>.completed.json` on a Q6 Proceed, `<session-id>.cancelled.json` on a Q6 Cancel. Neither archive path promotes to `ops.config.json` or to persistent memory.
