---
name: agent-boot
description: Session-start checks the agent runs before acting on the user's message. Scans for pending PR iteration loops and surfaces a resume prompt per pending PR. Never auto-resumes silently.
portable: true
scope: every agent invocation on a project with autonomous pr-iteration enabled
---

# Agent boot

## The rule

On every agent invocation, before the user's message is acted on, scan `.development/local/pr-iteration/*.json` for pending iteration states (files without a `.stopped` or `.paused` sidecar). For each pending state, surface a single prompt to the user:

> PR #N (`<owner>/<repo>#<number>`) has a pending iteration loop (last checked M minutes ago, state: `<lastPollResult.ciState>`, unresolved: `<lastPollResult.unresolvedCount>`). **Resume / defer / stop?**

The user's answer determines the next action:

- **Resume**: call `runTick` immediately from `scripts/lib/pr-iteration/tick.mjs`. If the tick returns `needs-triage`, enter the fix round per `rules/pr-iteration.md` steps 5-6, then reschedule the next wakeup. If `still-waiting`, reschedule directly. If `complete`, report and stop.
- **Defer**: leave the state file in place. Skip this session without rescheduling. The state file stays for the next session's boot check.
- **Stop**: call `markPrStateStopped` from `scripts/lib/pr-iteration/state.mjs` with reason "user stopped at session start". The next wakeup fire (if any) reads the sidecar and exits cleanly.

## Why never auto-resume

A user may have opened the IDE for unrelated work. Auto-resuming a PR iteration loop mid-conversation would inject unexpected tool calls and context consumption. The prompt keeps the user in control.

## Paused states

If a `.paused` sidecar exists (safety cap was hit), surface a different prompt:

> PR #N iteration loop was paused (safety cap: N consecutive wakes without progress). Last known state: CI `<ciState>`, unresolved: `<count>`. **Resume / investigate / dismiss?**

- **Resume**: delete the `.paused` file, reset `consecutiveWakes` to 0 in the state file, and run a tick.
- **Investigate**: read the state file and last poll result, surface a summary, let the user decide.
- **Dismiss**: leave the `.paused` file. The loop stays paused.

## Config

- `workflow.external_review.autonomous.enabled`: when `false`, skip this entire boot check (no autonomous loops to resume).

## Related

- `rules/pr-iteration.md`: the binding contract for the iteration loop.
- `skills/pr-iteration/SKILL.md`: the orchestration skill.
- `scripts/lib/pr-iteration/state.mjs`: state read/write/list.
