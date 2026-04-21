---
name: issue-discovery
description: When the user asks "what should I work on?" or gives a free-form description with no issue reference, run the staff-engineer intake interview instead of guessing. Never guess. Offer 2-4 options plus custom at every branch. Delegate all tracker writes through tracker-sync.
portable: true
scope: every session where the agent is about to start work on a dev issue that has not yet been named
---

# Issue discovery

## The rule

When a session is about to begin work on a dev issue and the user has not supplied a resolvable issue reference, the agent runs the `issue-discovery` skill as its first step. The skill interviews the user as a staff engineer would interview a manager: short, decision-by-decision prompts that refuse to progress without an explicit answer, and never silently invent a default.

Three clauses are binding on every node of the interview, every surface that consumes its output, and every skill that delegates into it.

### Clause 1: never guess

The skill does not "pick a reasonable default" to move the session forward. When the facts needed to proceed are thin, incomplete, or contradictory, the skill halts per [rules/ambiguity-halt.md](ambiguity-halt.md) and asks. Staff engineers escalate judgement calls to their manager; the skill does the same to the user.

Applies to:

- Choosing a target project when more than one writable `trackers.dev` is configured.
- Selecting an issue from the open-issues shortlist.
- Picking the issue type, area label, priority, size, or release umbrella.
- Filling in acceptance criteria, non-goals, rollback plan, or any other required field.

"I'll just pick the first one" is not a valid path. "The most recent issue" is not a valid path. "The area that appears in the user's sentence" is not a valid path. The skill asks.

### Clause 2: 2 to 4 options plus custom at every branch

Every node where the user must choose from the configuration surface (trackers, areas, intents, umbrellas, templates) presents **2 to 4 concrete domain options and one custom escape hatch**. Fewer than 2 domain options collapses the branch to yes or no and hides the deliberation the intake is designed to surface. More than 4 domain options overloads the user.

"Domain options" means the actual choices drawn from the configured surface (trackers in `trackers.dev[]`, areas in `labels.area`, the configured umbrellas, etc.). Meta-options (a "show more" pager on shortlists, the "something else" custom escape hatch) are navigational controls and do NOT count toward the 2-4 limit. A shortlist prompt can legally render 4 issues + "show more" + "file a new one" and still satisfy the contract.

- Shortlists (issues, umbrellas) are ranked by a deterministic criterion (priority + age for issues; status + target date for umbrellas) and capped at 4 domain options. A "show more" meta-option is always offered on top when more candidates exist on the tracker.
- "Custom" is always the last option and always triggers a halt per [rules/ambiguity-halt.md](ambiguity-halt.md) when the custom value falls outside the configured surface (e.g. an area that does not exist in `labels.area`, an intent not in `labels.intent`). Halt surfaces the next step as an `adapt-system` invocation.

### Clause 3: delegate every tracker write to tracker-sync

The skill reads from and collects structured data about the tracker, but **never calls the tracker API directly**. Every create, update, link, and read routes through [skills/tracker-sync/SKILL.md](../skills/tracker-sync/SKILL.md). This mirrors [rules/tracker-source-of-truth.md](tracker-source-of-truth.md) but is called out explicitly here because the intake is the first place a newly-arriving user's intent hits bundle code: a single direct `gh`/`jira`/`linear` call here would break the invariant for every downstream skill.

The one public exception is `release-tracker`: the skill calls the `release-tracker` public entry point `createUmbrellaForIntent(intent, payload)` rather than `tracker-sync.create_release_umbrella` directly, so release-tracker can recompute umbrella status as a side effect. `release-tracker` owns the final tracker-sync dispatch.

## Message shape

Every prompt in the interview follows the shape:

```text
<one-sentence context restating what the skill knows so far>

<short question ending with `?`>

1. <option one (concrete, quotable)>
2. <option two>
(3. <option three if present>)
(4. <option four if present>)
N. Something else (I'll halt so we can decide).
```

- No emojis.
- No em or en dashes (see [rules/no-dashes.md](no-dashes.md)).
- No apology framing, no filler, no hedging.
- The numbered list is strict: the user's reply is parsed by number first, then free-form.

Matches the [rules/ambiguity-halt.md](ambiguity-halt.md) minimum contract; this rule adds the option-count and custom-escape format on top. If a caller ever picks between the two, ambiguity-halt wins: its message shape is the portable minimum every skill honours.

## Hard never-do list

While the interview is open (a session-state file under `.development/local/issue-discovery/` exists and has not been archived), the skill MUST NOT:

- Call `tracker-sync.issues.createIssue` without a completed Q6 confirmation gate.
- Call `release-tracker.createUmbrellaForIntent` (or any other umbrella-create surface) without a completed Q5 or Q4a branch.
- Infer a default from the user's first message and skip ahead to Q6.
- Auto-resume a stale session (older than 24 hours) without explicit user confirmation.
- Promote anything from the session scratch file into `ops.config.json` or into persistent project memory.
- Start a second `issue-discovery` session in parallel for the same target project.

Read-only work (listing open issues, listing umbrellas, scoring areas against the user's intent) stays allowed. The skill may gather more context to improve the options it presents before asking.

## Resume protocol

On agent boot (future work covered by the session-resume rule), an open session under `.development/local/issue-discovery/` is surfaced as:

```text
Found an unfinished issue-discovery session from <ISO timestamp> about "<intent>".
Last node reached: <node id>.

1. Resume from where we left off.
2. Discard and start over.
3. Leave it; I'll come back to it later.
```

The user's answer is authoritative. "Leave it" does not promote the state to durable config; the file stays where it is for the next session to surface again.

## What counts as a stale session

A session file older than 24 hours is treated as stale. The skill still surfaces it on resume, but the default offered answer is "Discard and start over". The user can still pick "Resume from where we left off"; the choice is explicit either way.

## Related

- [skills/issue-discovery/SKILL.md](../skills/issue-discovery/SKILL.md): the skill contract and the decision tree.
- [skills/issue-discovery/runbook.md](../skills/issue-discovery/runbook.md): the branch-by-branch Q&A script with exact wording and halt scenarios.
- [rules/ambiguity-halt.md](ambiguity-halt.md): the portable minimum halt contract this rule sits on top of.
- [rules/tracker-source-of-truth.md](tracker-source-of-truth.md): the tracker-is-source rule this rule reinforces.
- [rules/pr-workflow.md](pr-workflow.md): the two human gates every dev-loop hand-off respects (merge, Done). Issue-discovery sits BEFORE dev-loop and does not cross either gate.
- [memory-seeds/issue-discovery-posture.md](../memory-seeds/issue-discovery-posture.md): the one-paragraph memory seed that travels to every installed project.
