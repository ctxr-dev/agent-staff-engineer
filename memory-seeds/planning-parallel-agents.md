---
name: Parallel Explore agents during planning
description: During Phase 1 of any non-trivial plan, fan out 2 to 3 Explore agents in parallel. Rarely use only 1.
type: feedback
portable: true
tags: []
placeholders: []
---

During Phase 1 of any plan for this project, launch 2 or 3 Explore agents in parallel (single message, multiple tool calls) so their results come back together and feed the plan jointly.

**Why:** planning quality on this project correlates strongly with breadth of exploration before design. One agent often misses cross-cutting concerns. Three parallel agents with distinct briefs catch them.

**How to apply:** before the first Plan agent runs, split the exploration into 2 or 3 narrow briefs (example split: existing patterns, test infrastructure, related features). Launch them in the same message. Wait for all results, then proceed to design. Use 1 agent only when the task is truly scoped to known files.
