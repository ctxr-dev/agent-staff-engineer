<!--
agent-staff-engineer template: compound-learning.md
purpose: Registry template for the "Patterns that worked / failed / Codebase quirks"
         sections inside a project's CLAUDE.md. The shape below is what
         scripts/lib/claude-md/seed.mjs writes on a fresh install and what
         scripts/lib/claude-md/append-entry.mjs upserts at runtime.
rendered by: scripts/lib/claude-md/seed.mjs (initial stub)
              scripts/lib/claude-md/append-entry.mjs (per-entry upserts)
stored at: <project>/CLAUDE.md (between the registry begin/end markers)
ops.config keys read:
  - none (this template defines structure; no config interpolation)
scalar placeholders:
  - none (entries are appended via the helper, not via this template directly)
notes:
  CLAUDE.md is a bulletin board: short, distilled patterns. The canonical
  archive is the team's skill-llm-wiki tree at <paths.wiki>/knowledge/.
  Entries here may link out to wiki paths; never duplicate a wiki entry
  verbatim. Read design/claude-md-authoring.md for the editorial cadence.
-->

# CLAUDE.md compound-learning registry

## Project context

<!-- one paragraph; ~ 200 words; what is special about this repo -->
[placeholder: fill in after the first few agent runs surface concrete examples]

## Compound learning

### Patterns that worked

<!--
Each entry follows this shape. Required fields: Status, First seen,
Remediation, Next review. The Title is the H3.
-->

<!--
### Pattern: <one-line title>
- Status: worked
- First seen: YYYY-MM-DD in <issue / PR ref> (<one-line trigger>).
- Linked: <issue or PR numbers, optional>
- Remediation: <pointer to rule, doc, or commit; one line>.
- Owner: <name or team, optional>
- Next review: YYYY-MM-DD
-->

### Patterns that failed

<!--
Same shape; status is "failed" or "abandoned". Always include a
remediation pointer (what was tried and replaced) so future agents
do not retry the same dead-end.
-->

### Codebase quirks

<!--
One-liners. Non-obvious facts an agent could not derive by reading
the code:
- Legacy branch policies (e.g. "main is the deploy branch; release/* is for hotfixes only").
- Build-system invariants (e.g. "the postinstall hook expects $REPO_ROOT to be writable").
- "If you touch X, also update Y" couplings.
-->
