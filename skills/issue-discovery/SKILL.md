---
name: issue-discovery
description: Staff-engineer intake interview the agent runs before any dev-loop when the user has no resolvable issue reference. Asks every decision point with 2-4 options plus custom; never guesses; halts per rules/ambiguity-halt.md on thin facts; delegates every tracker write to tracker-sync. One invocation produces one issue (and optionally one new release umbrella), then hands the resolved handoff tuple to dev-loop.
trigger_on:
  - User says "what should I work on?", "pick up next", "get me unstuck", or any equivalent with no issue reference.
  - dev-loop is invoked without an issue reference, or with one that tracker-sync.issues.getIssue cannot resolve; dev-loop halts its own state machine at entry and hands off here.
  - User explicitly runs `/issue-discovery [hint]`.
  - regression-handler concludes "file new bug issue" and delegates issue creation here with a pre-filled type of bug in the payload.
do_not_trigger_on:
  - User supplied a resolvable issue reference up front (dev-loop takes it directly).
  - ops.config.json is missing or invalid (halt and point at bootstrap-ops-config first).
  - "Every configured `trackers.dev` has depth read-only (halt; the skill cannot create issues anywhere)."
  - Another `issue-discovery` session is already open on this target project (surface the existing session per Resume protocol; never run two in parallel).
writes_to_github: no, via tracker-sync only and only after the Q6 confirmation gate returns "Proceed"
writes_to_filesystem: yes, a session-scratch JSON under .development/local/issue-discovery/<session-id>.json (gitignored; managed via scripts/lib/sessionState.mjs)
---

# issue-discovery

Before acting, read the target project's `.claude/ops.config.json`. Refuse to run if missing or invalid; hand the user back to `bootstrap-ops-config`.

Hard rule baked in: **the skill never calls a tracker API directly.** Every create, update, link, and read routes through [skills/tracker-sync/SKILL.md](../tracker-sync/SKILL.md). The one public exception is [skills/release-tracker/SKILL.md](../release-tracker/SKILL.md)'s `createUmbrellaForIntent` entry point for new-umbrella creation; release-tracker owns the final tracker-sync dispatch.

## Inputs

- Optional free-form intent from the user (e.g. "I want to work on the checkout flow"). When absent, Q0 starts with "What do you want to work on?".
- Optional `type` pre-fill when delegated from `regression-handler` (e.g. `{type: "bug"}` skips Q3c; other nodes still run).
- Optional `memberName` pre-fill when delegated from `dev-loop` with a workspace member it already identified (e.g. from a file path under a `workspace.members[]` entry); Q1 still runs to confirm.

## Outputs

- On success: a resolved handoff tuple `{issueRef, umbrellaRef | null, memberName | null}` conforming to `schemas/issue-discovery-handoff.schema.json`. The caller (typically `dev-loop`) consumes the tuple and resumes its own state machine.
- On user-cancel at Q6: no tracker writes; the session state file is archived with `status: "cancelled"` for audit. The skill returns control to the caller with a cancelled-handoff result.
- On halt per ambiguity-halt: no tracker writes; the session state file is preserved at the current node for resume on the next turn.

## State machine

```text
[ENTRY]
  preconditions: valid ops.config.json; at least one writable trackers.dev
  load: trackers.dev[], trackers.release?[], workspace.members[]?
  pre-fetch (via tracker-sync, read-only): open issues, open umbrellas, labels
      |
      v
[Q0. ONE-LINER TOPIC CONFIRMATION]
  agent proposes: "I understand you want to <inferred>. Correct?"
  1. Yes, continue.
  2. Adjust: <free-form edit>.
  3. I misunderstood; start over.
      |
      v
[Q1. WHICH PROJECT OR WORKSPACE MEMBER?]
  skipped iff exactly one writable dev-tracker AND no workspace.members[]
  1..N: each writable target (at most 4; "show more" at N+1)
  N+1: something else -> halt per ambiguity-halt with `/adapt-system` hint
      |
      v
[Q2. EXISTING OR NEW?]
  skipped to Q3b iff zero open issues on the target
  1. Pick from the existing open issues (go to Q3a).
  2. File a new one (go to Q3b).
  3. Show me the full list first (re-enters Q2 with an expanded shortlist).
      |
      |-- existing -> [Q3a. PICK FROM SHORTLIST]
      |                 top 4 ranked by (priority, age)
      |                 5. Show more (up to 8 total).
      |                 6. None of these; file a new one (go to Q3b).
      |
      v (new)
[Q3b. TITLE FOR NEW ISSUE]
  agent proposes 2 to 3 titles derived from Q0 + matched area keywords
  1..3: propose title
  4. I will write the title.
      |
      v
[Q3c. ISSUE TYPE]
  skipped when the caller pre-filled `type`
  1. feature
  2. task
  3. refactor
  4. bug (hand off to regression-handler if this was a direct invocation)
      |
      v
[Q3d. AREA LABEL]
  agent scores user intent against area_keywords; presents top 3 plus custom
  1..3: propose area
  4. Something else (halt per ambiguity-halt with `/adapt-system` hint)
      |
      v
[Q3e. PRIORITY + SIZE]
  two short sequential prompts, 3 options each
  priority: 1. high | 2. medium | 3. low
  size: 1. small (<1d) | 2. medium (1-3d) | 3. large (split later)
      |
      v
[Q3f. ACCEPTANCE CRITERIA]
  1. Let me write them now.
  2. Use the configured template placeholders (filled before Q6).
  3. None; this is exploratory. (Valid choice, but picked explicitly.)
      |
      v
[Q4. RELEASE UMBRELLA]
  skipped when trackers.release is absent from ops.config.json
      |
      v
  [Q4-detect] list open umbrellas via tracker-sync.issues.listIssues
      |
      |-- >=1 open umbrellas -> [Q4a. PICK]
      |   1..4: open umbrellas
      |   5. Reference by number (user types #NNN).
      |   6. No umbrella for this one. (Halt per ambiguity-halt to confirm,
      |      because trackers.release exists so skipping is a decision.)
      |
      |-- 0 umbrellas -> [Q4c. NEW UMBRELLA?]
      |   1. Create new umbrella (go to Q5).
      |   2. Skip umbrella link this time.
      |
      v
[Q5. NEW-UMBRELLA Q&A] (only if Q4c picked "Create new umbrella")
  8 sub-questions, one at a time (see runbook.md for exact wording):
    5.1 intent label value (from labels.intent or "new:<slug>" -> halt)
    5.2 umbrella goal (one paragraph)
    5.3 scope tag (single free-form)
    5.4 target date (YYYY-MM-DD or "none")
    5.5 non-goals (bullets; "none" valid)
    5.6 definition of done (bullets; must include tested + released + monitored)
    5.7 rollback plan (one paragraph)
    5.8 stakeholders (comma-separated or "none")
      |
      | call release-tracker.createUmbrellaForIntent(intent, payload);
      | release-tracker recomputes umbrella status after creation.
      v
  loop back to Q4a with the new umbrella pre-selected (user still confirms)
      |
      v
[Q6. CONFIRMATION GATE]
  agent echoes the full planned action in a single block:
    - Create issue on <project> titled "<title>" with type=<type>,
      labels=<labels>, priority=<p>, size=<s>.
    - Link to umbrella <umbrella_ref> (or "no link").
    - Then hand off to dev-loop.
  1. Proceed (calls tracker-sync.issues.createIssue).
  2. Change something (free-form; re-enters the relevant node).
  3. Cancel (archives session, returns cancelled-handoff).
      |
      v
[EXIT]
  return {issueRef, umbrellaRef?, memberName?} to the caller.
  archive session state file.
```

Every arrow is explicit. The flow never falls through on silence; each node sits in "awaiting answer" until the user responds.

## Session persistence

The session scratch file is ephemeral local state, not a durable artefact. Unlike reports and runbooks (see [rules/llm-wiki.md](../../rules/llm-wiki.md) for the wiki-routed shared-topic contract), this skill's state is transient: written with `atomicWriteJson`, validated against `schemas/issue-discovery-session.schema.json` on read, and archived or discarded on terminal nodes. It never passes through `@ctxr/skill-llm-wiki` and never lands in `.development/shared/`.

- Location: `.development/local/issue-discovery/<session-id>.json`, gitignored per the bundle's standing `.development/local/` convention.
- Format: validated against `schemas/issue-discovery-session.schema.json` on every read so a corrupted file fails loud.
- Write mechanism: `scripts/lib/fsx.mjs#atomicWriteJson` via the shared `scripts/lib/sessionState.mjs` helper. Never through `@ctxr/skill-llm-wiki` (the wiki is for frontmatter-bearing durable artefacts; this is ephemeral scratch).
- Fields: `startedAt`, `intentText`, `currentStep`, `answers[]`, `proposedPayload`, `umbrellaDecision`, `topicConfirmed`, `trackerTarget`, `memberName`.
- Resumption: on a fresh session, if a file less than 24 hours old exists for the same target project with no `createdIssueRef`, the agent surfaces it per the Resume protocol in `rules/issue-discovery.md`. Older than 24 h: still surfaced, but the default offered answer is "Discard and start over".
- Archival: on Q6 `Proceed` (issue created) the session file is renamed with a `.completed.json` suffix; on Q6 `Cancel` it is renamed with a `.cancelled.json` suffix. Neither archive path promotes to durable config or persistent memory.

## Idempotency

- Re-invoking the skill with a still-open session resumes from the recorded `currentStep` after explicit user confirmation.
- The Q6 confirmation gate is stateless: a re-run of the same interview against the same tracker state that the user previously Proceeded to completion will detect the existing issue by title + labels fingerprint via `tracker-sync.issues.createIssue`'s dedupe contract and return the existing issue number rather than creating a duplicate.

## Failure modes

- **ops.config.json missing or invalid**: halt and hand control to `bootstrap-ops-config`.
- **No writable `trackers.dev`**: halt with a pointed message naming the depth of each configured target.
- **Tracker read fails (auth, rate-limit, network)**: halt per the `tracker-sync` failure modes; the session file preserves the current node so a retry resumes cleanly.
- **User picks a custom area / intent / type not in the configured surface**: halt per `rules/ambiguity-halt.md`; the message names `/adapt-system` as the next step.
- **`tracker-sync.issues.createIssue` throws `NotSupportedError` (e.g. Jira backend)**: halt cleanly with the tagged error; the session file is preserved so a follow-up session can resume once the backend lands.
- **User abandons mid-interview**: no tracker writes fire; the session file remains at its last node for resume.

## Cross-skill handoffs

- **`dev-loop`**: the caller that most often invokes this skill. When `dev-loop` is run without an issue reference (or with one that fails to resolve), it halts its own state machine at entry, invokes `issue-discovery`, and resumes only after the skill returns a resolved handoff tuple. The tuple shape is enforced by `schemas/issue-discovery-handoff.schema.json`.
- **`tracker-sync`**: the only skill this one writes through. Reads use `issues.listIssues`, `issues.getIssue`, and `labels.reconcileLabels`'s dry-run plan. Writes use `issues.createIssue` (at Q6 Proceed only).
- **`release-tracker`**: new-umbrella creation routes through `release-tracker.createUmbrellaForIntent(intent, payload)` (a public entry point release-tracker owns); release-tracker dispatches to `tracker-sync` internally and recomputes umbrella status after the create.
- **`regression-handler`**: soft bidirectional handoff. When `regression-handler` triage concludes "file new bug issue", it invokes this skill with `{type: "bug", ...pre-fill}` and the skill skips Q3c. When Q3c is reached in a direct invocation and the user picks `bug`, the skill hands off to `regression-handler` for the triage-first flow and `regression-handler` tail-calls back.
- **`adapt-system`**: cross-linked only. When a user's custom answer requires a schema / labels / seeds change (new area, new intent, new stakeholder), the skill halts and names `/adapt-system <short desc>` as the next command. The skill itself never invokes adapt-system automatically.
- **`plan-keeper`**: optional. After `tracker-sync.issues.createIssue` returns a ref, if `workflow.pr.update_plan_oneliner` is true the skill calls `plan-keeper.createPlanStub({issueRef, title, owner})` (a plan-keeper public entry point) to seed a `todo/<slug>.md` stub. `plan-keeper` is the only skill that writes under `paths.plans_root`.

## Project contract

- `project.default_branch`, `project.principals.reviewers_default`.
- `trackers.dev[]` (at least one entry with depth != `read-only`).
- `trackers.release` (optional; absent means the Q4 umbrella branch is skipped entirely per the PR 7 rule).
- `workspace.members[]` (optional; present for multi-repo workspaces).
- `labels.type`, `labels.area`, `labels.priority`, `labels.intent`, `labels.size` (every label set the interview offers as an option comes from here).
- `workflow.issue_discovery.title_templates` (optional; when present, Q3b uses these as the proposal seeds instead of area-keyword matching).
- `workflow.issue_discovery.stakeholders` (optional; surfaced as options at Q5.8).
- `workflow.issue_discovery.domain_glossary` (optional; surfaces a one-line definition when an answer matches a glossary term).
- `workflow.issue_discovery.default_type` (optional; when set and the caller did not pre-fill `type`, Q3c surfaces this as option 1 instead of `feature`).
- `workflow.issue_discovery.topic_confirmation` (default true; setting false suppresses Q0, but callers are warned the skill is still expected to infer intent from the user's first message rather than guess).
- `workflow.pr.update_plan_oneliner` (optional; when true, the skill calls `plan-keeper.createPlanStub` after create).
- `paths.plans_root` (resolved via plan-keeper).
