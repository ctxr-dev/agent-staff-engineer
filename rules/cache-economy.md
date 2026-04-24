---
name: cache-economy
description: Every SKILL.md partitions its body into a static block (cacheable across invocations within the 5-minute TTL) and a dynamic block (appended per invocation). The static block is wrapped with cache_control ephemeral at the API level.
portable: true
scope: every SKILL.md in the bundle and in installed target projects
---

# Cache economy

## The rule

Every SKILL.md with more than 40 non-blank lines of body content MUST contain two HTML comment markers that partition the body into a static block and a dynamic block:

```markdown
---
name: my-skill
description: ...
---

<!-- cache-control:static -->

# my-skill

(Skill identity, state machine, invariants, cross-links, project contract.)

<!-- cache-control:dynamic -->
```

The **static block** (between `<!-- cache-control:static -->` and `<!-- cache-control:dynamic -->`) contains everything that does not change between invocations: skill identity, purpose, state machine diagrams, invariants ("never merges"), tool-schema references, rule cross-links, project contract keys, and failure mode documentation. This block is wrapped with `cache_control: { "type": "ephemeral" }` at the API level so it stays in Anthropic's prompt cache for the 5-minute TTL.

The **dynamic block** (after `<!-- cache-control:dynamic -->`) is where the skill loader appends per-invocation context: the current issue body, the current diff, runtime parameters, and any session-specific state. This content is never cached.

## Why

At 2026 pricing, cached reads cost 10% of base input tokens; cache writes cost 125%. Within the 5-minute TTL, any skill invoked twice pays the write premium once and reads at 10% on every subsequent call. For burst workflows (dev-loop invoking pr-iteration invoking code-review within one session), the savings compound to 3 to 10x on realistic workloads. Without explicit markers, the entire SKILL.md is treated as dynamic input every turn and pays full price.

## Lint enforcement

`scripts/lint/require-cache-block.mjs` checks every SKILL.md in `skills/*/` for both markers. Files below the 40-line threshold are exempt (caching overhead exceeds savings at small sizes). The lint runs as part of `npm test`.

## Before / after example

**Before** (dev-loop/SKILL.md, no markers):

```markdown
---
name: dev-loop
description: Drives one dev issue...
---

# dev-loop

Before acting, read the target project's `.claude/ops.config.json`...
```

**After** (dev-loop/SKILL.md, annotated):

```markdown
---
name: dev-loop
description: Drives one dev issue...
---

<!-- cache-control:static -->

# dev-loop

Before acting, read the target project's `.claude/ops.config.json`...

(... entire body ...)

<!-- cache-control:dynamic -->
```

## Related

- `rules/pr-iteration.md`: the iteration loop whose wakeup interval (270s) is tuned to stay inside the cache TTL.
- P4.1 (#32): per-skill token accounting that measures whether this annotation pass pays off.
- P4.3 (#33): cache-hit-rate monitoring.
