---
name: Delegation triggers
description: Dispatch a Soldier subagent via the Agent tool only when a concrete trigger fires (>200 lines to read, >3 search queries, cross-skill scope). Short atomic tasks run in-line. Soldiers never talk to the user; the Captain owns the conversation.
type: feedback
portable: true
tags: []
placeholders: []
---

The agent has two roles: the Captain (the root session talking to the user) and the Soldier (a single Agent-tool invocation). Delegation earns its cost only when a concrete trigger fires.

**Why:** the Agent tool adds fixed overhead (briefing + return-trip + report parsing). On small tasks the overhead outweighs the context-budget gain. On big tasks the Captain's context fills with Soldier-shaped reading (diffs, test output, full files) and user-facing decisions start to suffer. The triggers below pick the split where delegation actually pays off.

**How to apply:**

- Trigger 1: reading budget. Delegate when the task would pull >200 lines of file content into the Captain's context. Otherwise read in-line.
- Trigger 2: search breadth. Delegate when the task needs >3 independent Grep / Glob / Explore queries. Otherwise run the queries directly.
- Trigger 3: cross-skill scope. Delegate when the task spans two skills (eg "run code review AND fix the findings"). Split so each Soldier owns one skill's surface.
- No other reasons. No "just to be safe", no "the user might like parallelism", no "it feels cleaner".
- Three Soldier shapes: Explorer (read-only), Implementer (write), Reviewer (read + verdict). Pick one; never blend.
- Every Soldier returns a JSON report validated against `schemas/soldier-report.schema.json`. The Captain verifies at least one claim against the filesystem before acting.
- Soldiers never talk to the user. User-facing conversation stays on the Captain.
- Soldiers honour every existing bundle rule (tracker-source-of-truth, pr-workflow human gates, plan-keeper as sole plan writer, llm-wiki for `.development/**`, ambiguity-halt when facts are thin).

The binding contract lives at `rules/subagent-orchestration.md`; the how-to with briefing templates lives at `skills/orchestrator/SKILL.md`.
