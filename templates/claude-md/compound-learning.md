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

<!--
The H1 above is the title of THIS template document. It is NOT
emitted into a project's CLAUDE.md. The seeder
(scripts/lib/claude-md/seed.mjs) writes the content from
`## Project context` downward, between its begin/end markers.
Project-side CLAUDE.md files keep whatever H1 the project author wrote.
-->

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
- First seen: YYYY-MM-DD.
- Linked: <issue or PR refs, optional>
- Remediation: <pointer to rule, doc, or commit; one line>.
- Owner: <name or team, optional>
- Next review: YYYY-MM-DD

The append helper at scripts/lib/claude-md/append-entry.mjs renders
this exact shape. `Linked` and `Owner` are emitted only when
supplied. `Next review` defaults to first-seen + 6 months
(end-of-month clamped, not rolled over) when omitted.
-->

### Patterns that failed

<!--
Same H3 + bullet shape as "Patterns that worked"; the only
difference is `Status: failed` (the renderer derives it from
`--section failed`). Always include a Remediation pointer (what
was tried and replaced) so future agents do not retry the same
dead-end.
-->

### Codebase quirks

<!--
One-liner bullets describing non-obvious facts an agent could not
derive by reading the code. The append helper at
scripts/lib/claude-md/append-entry.mjs --section quirk renders
each quirk as:

  - <title>[ (<linked>)]. Remediation: <pointer>. Last verified: YYYY-MM-DD.

Examples:
- "main is the deploy branch; release/* is for hotfixes only"
  (Remediation: "branch from main for new features").
- "the postinstall hook expects $REPO_ROOT to be writable"
  (Remediation: "see scripts/postinstall.sh").
- "if you touch src/auth.ts, also update tests/auth-e2e.test.ts"
  (Remediation: "covered by the auth-coupling rule").
-->
