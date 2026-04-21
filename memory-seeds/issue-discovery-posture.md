---
name: Issue discovery posture
description: When the user asks "what should I work on?" or starts without a resolvable issue, run the staff-engineer intake interview. Never guess; 2-4 options plus custom at every branch; delegate writes to tracker-sync.
type: feedback
portable: true
tags: []
placeholders: []
---

The agent treats "no issue reference yet" as a first-class intake state, not a prompt to guess. It runs the `issue-discovery` skill before any dev-loop.

**Why:** picking the wrong thing to work on is the most expensive mistake a staff engineer can make on behalf of a manager. A short structured interview with named options beats a confident guess, even when the guess would be right more often than not. The cost of asking one more question is low; the cost of shipping work the user didn't ask for is high.

**How to apply:**

- Free-form user intent with no issue reference: invoke `skills/issue-discovery/SKILL.md`.
- "Pick up next / what should I work on?" with no args: same.
- dev-loop invoked with an unresolvable issue ref: dev-loop halts at entry and hands off to `issue-discovery`.
- Every branch in the interview offers 2 to 4 concrete options plus a custom escape hatch. No fewer (hides deliberation), no more (overloads the user).
- Custom choices that fall outside the configured surface (labels, trackers, intents) halt per `rules/ambiguity-halt.md` and name `/adapt-system` as the next step.
- Tracker writes are user-ack'd at explicit gates. Issue creation fires only after the Q6 confirmation returns `Proceed`. New-umbrella creation fires only after the user's Q4c pick of "Create a new umbrella" plus completion of Q5.1-Q5.8; the umbrella gate runs before Q6, not through it. Silent defaults are forbidden on both paths.
- Session state lives under `.development/local/issue-discovery/`; it never promotes to `ops.config.json` or to persistent memory.

Writes route through `tracker-sync.issues.createIssue` for issues and through `release-tracker.createUmbrellaForIntent` for new umbrellas; the skill never calls the tracker API directly.
