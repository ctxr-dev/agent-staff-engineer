# issue-discovery runbook

Branch-by-branch Q&A script with exact wording, halt scenarios, and anti-patterns. `skills/issue-discovery/SKILL.md` is the contract; this file is the script the agent reads while driving the interview.

Voice: staff engineer to manager. Short, declarative. No hedging, no apology, no filler. Each prompt resolves exactly one decision; never compound.

## Node wording

### Q0. Topic confirmation

Opening probe. Always runs first unless `workflow.issue_discovery.topic_confirmation` is explicitly false.

When the user's first message contains a free-form intent:

```text
I understand you want to: {{inferred_intent}}.

Confirm or adjust?

1. Correct.
2. Adjust: <tell me what I missed>.
3. I misunderstood; start over.
```

When the user says only "what should I work on?" and no intent can be inferred, the prompt still conforms to the numbered-options contract in `rules/issue-discovery.md`: two domain options. The "custom escape hatch" clause of the rule applies to nodes where a user's answer must land inside the configured surface (trackers, areas, intents). Q0 has no such surface: the user is naming a topic in free text, so "something else" is meaningless here. Option 1 already IS the free-form path.

```text
I can't infer the topic yet. Two paths:

1. I'll name the topic in one sentence (I'll record it verbatim and confirm).
2. Help me narrow it down (I'll list the open issues and the areas configured on this project and we'll pick together).
```

Option 1 opens a free-form sub-prompt and records the answer as `session.intentText`. Option 2 pre-loads the shortlist and labels and re-enters Q0 with the confirmation prompt populated from the user's pick.

Proceed to Q1 once the user's answer is recorded verbatim in `session.intentText`.

### Q1. Project or workspace member

Skipped iff exactly one `trackers.dev` target is writable AND `workspace.members[]` is absent or empty.

```text
You have multiple writable targets. Which one owns this work?

1. {{trackers.dev[0].owner}}/{{trackers.dev[0].repo}} (depth: {{depth_0}})
2. {{trackers.dev[1].owner}}/{{trackers.dev[1].repo}} (depth: {{depth_1}})
(3. Workspace member "{{workspace.members[i].name}}" -> {{its tracker}})
N. Something else (I'll halt so we can wire it up via adapt-system).
```

When the user picks "Something else" and gives a free-form target, the skill halts per `rules/ambiguity-halt.md` with the message:

```text
I see you want to target "{{user_answer}}", which is not in `trackers.dev[]`. Adding a tracker target is an adapt-system change. Pick one of the configured targets, or halt for `/adapt-system "add tracker <short desc>"` first. How do you want me to proceed?
```

### Q2. Existing or new

Skipped to Q3b when `open_issues.length === 0` on the target.

```text
{{project}} has {{N}} open dev issues I can pick up. Choose:

1. Work on one of them (I'll show the top 8).
2. File a new one.
3. Show me the full list first.
```

When N == 0:

```text
{{project}} has no open dev issues I can write to. Two paths:

1. File a new one now.
2. Stop; I'll wait until something lands in the tracker.
```

Option 2 exits the skill cleanly: no tracker writes, no session archival. The file stays for a future resume if the user changes their mind.

### Q3a. Shortlist

Top 4 open issues by (priority descending, age ascending). `priority` and `size` labels are read off `labels.priority` and `labels.size` respectively.

```text
Top 4 open issues. Pick one:

1. #{{n1}} "{{title1}}" ({{priority1}}, {{age1}} old) {{area_labels_csv_1}}
2. #{{n2}} "{{title2}}" ({{priority2}}, {{age2}} old) {{area_labels_csv_2}}
3. #{{n3}} "{{title3}}" ({{priority3}}, {{age3}} old) {{area_labels_csv_3}}
4. #{{n4}} "{{title4}}" ({{priority4}}, {{age4}} old) {{area_labels_csv_4}}
5. Show more (up to 8 total).
6. None of these fit; file a new one.
```

On "Show more" the list extends to items 5-8 with the same ranking rules. On pick, jump to Q6 (the existing issue is the final target; no new one is created).

### Q3b. Title

Proposals are derived from `workflow.issue_discovery.title_templates` (if configured) or from `session.intentText` + the top-scoring area's label name.

```text
I can propose 3 titles based on what we've discussed. Pick or override:

1. "{{title_proposal_1}}"
2. "{{title_proposal_2}}"
3. "{{title_proposal_3}}"
4. I'll write the title myself.
```

Option 4 opens a free-form prompt. The user's input is recorded verbatim into `session.proposedPayload.title`.

### Q3c. Type

Skipped when the caller pre-filled `type`.

```text
What kind of work is this?

1. feature (new user-visible capability)
2. task (small, one-PR scope)
3. refactor (internal change, no user-visible delta)
4. bug (I'll route via regression-handler and come back)
```

If `workflow.issue_discovery.default_type` is set, it becomes option 1 and the other three shift down.

Option 4 hands off to `regression-handler` with `{title, intentText, memberName}` and the skill yields. `regression-handler` is expected to tail-call back into `issue-discovery` with `{type: "bug", ...pre-fill}` once it has completed its own triage; see `skills/regression-handler/SKILL.md`.

### Q3d. Area label

Score `session.intentText` against the keywords attached to each entry in `labels.area` (per the bundle-standard `area_keywords` shape). Surface the top 3 plus a custom option.

```text
Based on your intent, the top 3 areas are:

1. {{area_1}} (matched: {{keywords_1}})
2. {{area_2}} (matched: {{keywords_2}})
3. {{area_3}} (matched: {{keywords_3}})
4. Something else (halt; new areas are an adapt-system change).
```

When the user picks option 4 and types a free-form area, if that area is not in `labels.area[]` the skill halts per `rules/ambiguity-halt.md`:

```text
I see you want area "{{user_answer}}", which isn't in `labels.area`: {{configured_list}}. Adding a new area is an adapt-system change, not something I'll do silently. Pick an existing area, halt for `/adapt-system "add area <short desc>"` first, or re-route this issue to the closest existing area. How do you want me to proceed?
```

### Q3e. Priority + size

Two short sequential prompts, 3 options each. Both are required.

Priority:

```text
Priority?

1. high
2. medium
3. low
```

Size:

```text
Size?

1. small (<1 day)
2. medium (1-3 days)
3. large (split later)
```

### Q3f. Acceptance criteria

```text
What's the definition of done for this issue?

1. Let me write them now (free-form bullets).
2. Use the template placeholders (I'll fill them before I create).
3. None; this is exploratory. (Valid choice, but you picked it explicitly.)
```

Option 2 surfaces the configured issue template for the chosen type (`templates/issue-feature.md`, `issue-task.md`, `issue-refactor.md`, etc.) and the skill fills the `{{placeholder}}` tokens in-line with a sub-prompt per placeholder.

Option 3 is a valid terminal state but is recorded as `session.answers[q3f] = "exploratory"` so the Q6 confirmation block names it explicitly.

### Q4. Release umbrella

Entire branch skipped when `trackers.release` is absent from `ops.config.json`.

The skill runs `tracker-sync.issues.listIssues({labels:["type/release"], state:"open"})` (scoped to the configured release tracker) and branches on the result.

When >= 1 open umbrella:

### Q4a. Pick umbrella

```text
Which release umbrella rolls this up?

1. #{{n1}} "{{umbrella_title_1}}" (status: {{status_1}}, target: {{target_date_1}})
2. #{{n2}} "{{umbrella_title_2}}" (status: {{status_2}}, target: {{target_date_2}})
3. #{{n3}} "{{umbrella_title_3}}" (status: {{status_3}}, target: {{target_date_3}})
4. #{{n4}} "{{umbrella_title_4}}" (status: {{status_4}}, target: {{target_date_4}})
5. Reference by number (I'll ask for #NNN).
6. No umbrella for this one.
```

Option 6 is a decision (not a default), so the skill halts per `rules/ambiguity-halt.md`:

```text
Your config has `trackers.release` present but you picked "no umbrella". That's allowed but explicit. Confirm:

1. Yes, skip the umbrella link for this issue.
2. Actually, let me pick from the list again.
```

When 0 open umbrellas:

### Q4c. New umbrella?

```text
Your config has `trackers.release` pointed at {{release_project}} but no umbrellas are open. Two options:

1. Create a new umbrella (I'll run a short 8-question QA).
2. Skip the umbrella link this time; I'll still apply the intent label.
```

Option 1 advances to Q5.

### Q5. New-umbrella QA

Eight sub-questions, one at a time. Answers are collected into `session.umbrellaDecision.payload` and passed to `release-tracker.createUmbrellaForIntent(intent, payload)` at the end of Q5.8.

```text
Let's define the umbrella. Eight questions, one at a time.
```

#### Q5.1 Intent label value

```text
Intent label value. Configured: {{labels.intent.csv}}.

1. {{labels.intent[0]}}
2. {{labels.intent[1]}}
3. {{labels.intent[2]}}
4. new:<slug> (I'll halt for an adapt-system cascade.)
```

#### Q5.2 Umbrella goal

```text
In one paragraph, what does shipping this umbrella mean for the user?
```

Free-form. The skill refuses to accept an answer shorter than 30 characters; anything shorter prompts "That looks thin. Expand, or say 'none' to leave the goal blank.".

#### Q5.3 Scope tag

```text
Scope tag (single free-form, e.g. "app-store-launch"):
```

Single token, kebab-case. If the user types multiple tokens the skill normalises by joining with `-`.

#### Q5.4 Target date

```text
Target date (YYYY-MM-DD or "none"):
```

Strict date parse. Invalid date triggers a retry prompt, not a halt.

#### Q5.5 Non-goals

```text
Non-goals (bullets; one per line; "none" valid):
```

Free-form. Stored as an array of strings.

#### Q5.6 Definition of done

```text
Definition of Done (bullets; must include tested + released + monitored):
```

The skill parses the user's bullets and checks for the three required substrings (case-insensitive). Missing any -> re-prompts "I need to see `tested`, `released`, and `monitored` in the DoD. Add them and resend.".

#### Q5.7 Rollback plan

```text
Rollback plan (one paragraph):
```

Free-form, minimum 20 characters.

#### Q5.8 Stakeholders

```text
Stakeholders to notify on Done (comma-separated or "none").

Configured stakeholders: {{workflow.issue_discovery.stakeholders.csv}}.
```

Parsed as a comma-separated list. Entries not in the configured stakeholder list are preserved verbatim (with a warning printed once: "These stakeholders aren't in `workflow.issue_discovery.stakeholders`; consider adding them via adapt-system.").

After Q5.8 the skill calls:

```text
release-tracker.createUmbrellaForIntent({
  intent: session.umbrellaDecision.payload.intent,
  payload: session.umbrellaDecision.payload,
})
```

`release-tracker` recomputes umbrella status as a side effect and returns `{umbrellaRef}`. The skill loops back to Q4a with the new umbrella pre-selected (option 1) for explicit user confirmation.

### Q6. Confirmation

Final gate. The skill renders the entire planned action as a single readable block and asks the user to Proceed / Change / Cancel.

```text
Before I write anything, here's the plan:

- Create issue on {{project}} titled "{{title}}".
- Type: {{type}}. Labels: {{labels_csv}}. Priority: {{priority}}. Size: {{size}}.
- Link to umbrella {{umbrella_ref | "none"}}.
- Acceptance criteria: {{ac_summary | "exploratory"}}.
- After create, hand off to dev-loop.

1. Proceed.
2. Change something (say what).
3. Cancel.
```

On `1. Proceed`:

- Call `tracker-sync.issues.createIssue(payload)`.
- If a dedupe hit occurs (existing open issue with same title + labels fingerprint), `tracker-sync` returns the existing ref; the skill records it verbatim and continues.
- If `workflow.pr.update_plan_oneliner` is true, call `plan-keeper.createPlanStub({issueRef, title, owner})`.
- Archive the session file as `<session-id>.completed.json`.
- Return `{issueRef, umbrellaRef | null, memberName | null}` to the caller.

On `2. Change something`:

- Free-form prompt. The skill parses the user's reply and re-enters the relevant node. Common cases: "change title", "different area", "different umbrella", "swap priority to high".

On `3. Cancel`:

- No tracker writes fire.
- The session file is archived as `<session-id>.cancelled.json`.
- Return `{cancelled: true}` to the caller.

## Ambiguity-halt scenarios

All follow `rules/ambiguity-halt.md`: halt before any mutating call, surface one sentence per observation, ask once with bullets, resume only after the user's answer.

### Two umbrellas plausibly match

At Q4a, the candidate title matches two open umbrellas with near-equal signal (e.g. both carry `area/checkout` and both are in `In progress`).

```text
Before creating the issue I noticed something I cannot classify: two release umbrellas could own "{{title}}":

- #{{n1}} "{{title1}}" (status: {{status_1}}, target: {{target_1}})
- #{{n2}} "{{title2}}" (status: {{status_2}}, target: {{target_2}})

Both open, both carry `area/{{matching_area}}`. How do you want me to proceed?

1. Link to #{{n1}}.
2. Link to #{{n2}}.
3. Skip the umbrella link for this one.
```

### Picked issue drifted mid-interview

At Q3a the user chose #{{n}}; between list-fetch and Q6, `tracker-sync.issues.getIssue` reports it moved to `In review` with someone else's open PR.

```text
#{{n}} moved to `In review` and has open PR #{{pr}} by @{{other_login}}. How do you want me to proceed?

1. Pick another issue from the list.
2. Claim this one anyway (dev-loop will halt again at entry with the same observation).
3. File a new issue instead.
```

### New intent value collides with labels.intent

User answers Q5.1 with an intent not in `labels.intent[]`.

```text
You chose intent `{{user_answer}}` but `labels.intent` only has {{labels.intent.csv}}. Adding a new intent is an adapt-system change, not something I'll do silently. How do you want me to proceed?

1. Pick an existing intent.
2. Halt for `/adapt-system "add intent {{user_answer}}"` first.
3. Pick the closest existing intent for now.
```

### Release project is read-only

The interview reaches Q4 but every release project has `depth: read-only`.

```text
Your release project {{release_project}} is `read-only`, so I cannot create or link umbrellas there. How do you want me to proceed?

1. Proceed without an umbrella link.
2. Halt so you can raise the depth in `ops.config.json`.
```

### Unknown area requested

Q3d answer does not match any configured area.

```text
Area "{{user_answer}}" isn't in `labels.area`: {{configured_list}}. How do you want me to proceed?

1. Pick one of the configured areas.
2. Halt for `/adapt-system "add area {{user_answer}}"`.
3. Re-route this issue to the closest existing area (I'll propose options).
```

## Anti-patterns (MUST NOT do)

Hard prohibitions. Listed verbatim in the skill's `do_not_trigger_on` section and repeated here for the runbook reader.

1. **No silent creation.** Writes are user-ack'd at their respective gates: `tracker-sync.issues.createIssue` never fires without the Q6 confirmation returning `Proceed`; `release-tracker.createUmbrellaForIntent` never fires without the user's explicit Q4c pick of "Create a new umbrella" followed by completion of the Q5.1-Q5.8 sub-interview. The two gates are separate: umbrella creation is its own terminal (ack'd at Q4c), and issue creation is the Q6 terminal. An `apply: true` on the session state does not substitute for either gate.
2. **No implicit defaults.** "First writable target", "newest umbrella", "most likely area", "shortest title" are all invalid. Every selection is either an explicit user choice from the presented options or a halt.
3. **No compound questions.** Each prompt resolves exactly one decision. Never "Which project and which umbrella?" or "Which area, priority, and size?".
4. **No skipping steps for convenience.** "Just start something" still visits every node. The staff-engineer mirror would still ask.
5. **No cross-session memorisation.** Session state is the rolling JSON under `.development/local/issue-discovery/`; it never promotes to `ops.config.json` or to persistent memory. The next `/issue-discovery` starts clean.
6. **No inventing tracker targets, areas, intents, types.** If the user names something not in the configured surface, halt and point at `adapt-system`.
7. **No guessing umbrella from partial title match.** Fuzzy matches trigger the "two umbrellas" halt scenario.
8. **No batching multiple new issues.** One invocation produces one issue. Bulk issue creation is `tracker-sync.convert_rollout_to_issues`, a different operation.
9. **No writing outside `.development/local/issue-discovery/`.** The session scratch folder is the only writable surface for this skill apart from the tracker writes it dispatches via `tracker-sync` and `release-tracker`.
10. **No touching `daily/` or `knowledge/`.** Bundle-wide portable rule; the skill inherits it.
