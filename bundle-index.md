# Bundle index

Hand-authored routing doc for every skill/rule/template/seed the agent ships. The agent reads this FIRST for any concrete task, then loads only the doc slices it needs. Do not re-read AGENT.md end-to-end for routine operations; it covers one-shot bootstrap.

The validator (`scripts/validate_bundle.mjs` check #12) enforces two invariants:

- Every file referenced here exists.
- Every `skills/*/SKILL.md`, `rules/*.md`, `templates/*.md`, `memory-seeds/*.md` is referenced at least once here (no orphans).

When you add or remove a bundle doc, update this file in the same PR.

## Read first

- [AGENT.md](AGENT.md): agent entry point. Read the "Hard rules you must honour" section once per session; everything else is one-shot bootstrap.
- `bundle-index.md` (this file): route by intent / by surface / what to skip.
- [README.md](README.md): end-user-facing; skip at runtime unless the user is asking a README question.
- [INSTALL.md](INSTALL.md): installer reference; skip at runtime.
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor workflow; skip at runtime.
- [design/ARCHITECTURE.md](design/ARCHITECTURE.md): deep dive; load only when debugging structural questions or proposing a cross-cutting change.

## By intent

Most skills are triggered by a concrete intent. Map the user's ask to the minimal doc set.

### Discovering what to work on next (no issue ref yet)

- [skills/issue-discovery/SKILL.md](skills/issue-discovery/SKILL.md): the staff-engineer intake interview the agent runs before any dev-loop.
- [skills/issue-discovery/runbook.md](skills/issue-discovery/runbook.md): branch-by-branch Q&A script with exact wording and halt scenarios.
- [rules/issue-discovery.md](rules/issue-discovery.md): the three-clause binding rule (never guess; 2-4 options plus custom; delegate writes to tracker-sync).
- [rules/ambiguity-halt.md](rules/ambiguity-halt.md): minimum halt contract the interview sits on.
- [memory-seeds/issue-discovery-posture.md](memory-seeds/issue-discovery-posture.md): memory seed for the intake posture.
- [templates/issue-discovery-session.md](templates/issue-discovery-session.md): human-readable rendering of a session scratch file.

### Opening or driving a dev issue to "In review"

- [skills/dev-loop/SKILL.md](skills/dev-loop/SKILL.md): the state machine (branch, edits, local review, self-review, push, PR open, issue -> In review, hand off to pr-iteration).
- [rules/pr-workflow.md](rules/pr-workflow.md): the hard rules (two human gates; never merge; never Done).
- [rules/review-loop.md](rules/review-loop.md): pre-push local stages.
- [rules/tracker-source-of-truth.md](rules/tracker-source-of-truth.md): where state lives.
- [rules/no-dashes.md](rules/no-dashes.md): authoring rule for issue/PR bodies.
- [templates/pr.md](templates/pr.md): PR body template dev-loop renders.
- [templates/code-review-report.md](templates/code-review-report.md): self-review artefact (fallback; primary provider is `ctxr-skill-code-review`).

### Iterating on review comments on an open PR

- [skills/pr-iteration/SKILL.md](skills/pr-iteration/SKILL.md): the post-push loop orchestration.
- [skills/pr-iteration/runbook.md](skills/pr-iteration/runbook.md): canonical how-to with GraphQL recipes.
- [rules/pr-iteration.md](rules/pr-iteration.md): loop contract + exit conditions.
- [rules/ambiguity-halt.md](rules/ambiguity-halt.md): halt-and-ask contract when state is weird.
- [templates/pr-iteration-report.md](templates/pr-iteration-report.md): per-round artefact.

### Triaging a regression

- [skills/regression-handler/SKILL.md](skills/regression-handler/SKILL.md): the triage flow.
- [rules/ambiguity-halt.md](rules/ambiguity-halt.md): halt when the reported bug is already closed.
- [templates/regression-report.md](templates/regression-report.md): the filed report.
- [templates/issue-bug.md](templates/issue-bug.md): template for a new bug issue.

### Writing / keeping plans in sync

- [skills/plan-keeper/SKILL.md](skills/plan-keeper/SKILL.md): plan lifecycle + one-liner sync.
- [rules/plan-management.md](rules/plan-management.md): plan file layout, frontmatter, status moves.
- [rules/ambiguity-halt.md](rules/ambiguity-halt.md): halt when a status flip contradicts PR state.
- [memory-seeds/plan-lifecycle-moves.md](memory-seeds/plan-lifecycle-moves.md): memory seed for the lifecycle.

### Computing release umbrella state

- [skills/release-tracker/SKILL.md](skills/release-tracker/SKILL.md): umbrella status computation.
- [templates/issue-release.md](templates/issue-release.md): umbrella issue template.
- [templates/release-readiness-checklist.md](templates/release-readiness-checklist.md): readiness artefact.
- [templates/iteration-summary.md](templates/iteration-summary.md): iteration-closing summary.

### Reconciling labels, projects, PRs / MRs (the only tracker writer path)

- [skills/tracker-sync/SKILL.md](skills/tracker-sync/SKILL.md): label reconcile, project fields, issue CRUD, PR / MR ops across github / jira / linear / gitlab.
- [rules/tracker-source-of-truth.md](rules/tracker-source-of-truth.md): the governing rule.

### Bootstrap + config changes

- [skills/bootstrap-ops-config/SKILL.md](skills/bootstrap-ops-config/SKILL.md): first-install interview.
- [skills/adapt-system/SKILL.md](skills/adapt-system/SKILL.md): cascading diffs when the project reshapes.
- [rules/adaptation.md](rules/adaptation.md): adapt-system contract.
- [rules/ambiguity-halt.md](rules/ambiguity-halt.md): halt when the diff would touch hand-authored files.
- [memory-seeds/ops-config-usage.md](memory-seeds/ops-config-usage.md): config-access rule.

### Writing docs into `.development/**` (wiki-routed)

- [rules/llm-wiki.md](rules/llm-wiki.md): the skill-llm-wiki contract for project-side wikis.
- [memory-seeds/wiki-scalable-layout.md](memory-seeds/wiki-scalable-layout.md): memory seed on scalable wiki layout.

### Filing issues (pick template by kind)

- [templates/issue-feature.md](templates/issue-feature.md)
- [templates/issue-bug.md](templates/issue-bug.md)
- [templates/issue-task.md](templates/issue-task.md)
- [templates/issue-refactor.md](templates/issue-refactor.md)
- [templates/issue-release.md](templates/issue-release.md)

### Memory hygiene

- [rules/memory-hygiene.md](rules/memory-hygiene.md): what the agent captures (and doesn't) in project memory.
- Memory seeds (see the index below); the installer surfaces the stack-filtered subset as wrapper memory entries.

### Planning and parallel exploration

- [memory-seeds/planning-parallel-agents.md](memory-seeds/planning-parallel-agents.md): when and how to fan out Explore agents during Phase 1 of a plan.

### Commit style + authoring conventions

- [memory-seeds/commit-style-conventional.md](memory-seeds/commit-style-conventional.md): conventional-commits convention.
- [memory-seeds/dash-free-writing.md](memory-seeds/dash-free-writing.md): the no-em/en-dash rule as a memory.

### Testing discipline

- [memory-seeds/testing-discipline.md](memory-seeds/testing-discipline.md): test categorisation, no mocks at the integration boundary, results-table reporting.

### Stack-specific seeds (loaded only when the project's stack matches)

- [memory-seeds/swift-dst-day-count.md](memory-seeds/swift-dst-day-count.md): Swift `Calendar.date(byAdding:)` over raw-seconds arithmetic.
- [memory-seeds/xcui-combined-a11y.md](memory-seeds/xcui-combined-a11y.md): XCUITest combined-accessibility-elements gotcha.

## By surface

### Skills (9)

- [skills/adapt-system/SKILL.md](skills/adapt-system/SKILL.md): reshape config/labels/templates/rules/seeds on project-intent changes.
- [skills/bootstrap-ops-config/SKILL.md](skills/bootstrap-ops-config/SKILL.md): interactive first-install interview.
- [skills/dev-loop/SKILL.md](skills/dev-loop/SKILL.md): issue -> branch -> local review -> PR open -> In review.
- [skills/issue-discovery/SKILL.md](skills/issue-discovery/SKILL.md): staff-engineer intake interview when no issue ref is supplied.
- [skills/tracker-sync/SKILL.md](skills/tracker-sync/SKILL.md): sole tracker writer (github / jira / linear / gitlab); depth-gated per tracker target.
- [skills/plan-keeper/SKILL.md](skills/plan-keeper/SKILL.md): plan folder / frontmatter / lifecycle.
- [skills/pr-iteration/SKILL.md](skills/pr-iteration/SKILL.md): post-push loop until exit conditions hold.
- [skills/regression-handler/SKILL.md](skills/regression-handler/SKILL.md): bug triage + linked-issue proposal.
- [skills/release-tracker/SKILL.md](skills/release-tracker/SKILL.md): Release umbrella status computation.

### Rules (11)

- [rules/adaptation.md](rules/adaptation.md): when to invoke adapt-system.
- [rules/ambiguity-halt.md](rules/ambiguity-halt.md): halt-and-ask when state is weird.
- [rules/issue-discovery.md](rules/issue-discovery.md): the three-clause intake rule (never guess; 2-4 options plus custom; delegate writes).
- [rules/tracker-source-of-truth.md](rules/tracker-source-of-truth.md): the configured tracker(s) own state; local files are projections.
- [rules/llm-wiki.md](rules/llm-wiki.md): project-side wiki read/write contract.
- [rules/memory-hygiene.md](rules/memory-hygiene.md): project memory boundaries.
- [rules/no-dashes.md](rules/no-dashes.md): no em/en dashes in authored text.
- [rules/plan-management.md](rules/plan-management.md): plan folder + frontmatter + lifecycle.
- [rules/pr-iteration.md](rules/pr-iteration.md): post-push loop contract.
- [rules/pr-workflow.md](rules/pr-workflow.md): PR state machine + two human gates.
- [rules/review-loop.md](rules/review-loop.md): pre-push local review stages.

### Templates (12)

- [templates/code-review-report.md](templates/code-review-report.md): fallback self-review artefact.
- [templates/issue-bug.md](templates/issue-bug.md): bug issue body.
- [templates/issue-discovery-session.md](templates/issue-discovery-session.md): human-readable render of an issue-discovery session scratch file.
- [templates/issue-feature.md](templates/issue-feature.md): feature issue body.
- [templates/issue-refactor.md](templates/issue-refactor.md): refactor issue body.
- [templates/issue-release.md](templates/issue-release.md): release umbrella body.
- [templates/issue-task.md](templates/issue-task.md): task issue body.
- [templates/iteration-summary.md](templates/iteration-summary.md): iteration-closing summary.
- [templates/pr-iteration-report.md](templates/pr-iteration-report.md): per-round artefact.
- [templates/pr.md](templates/pr.md): PR body rendered by dev-loop.
- [templates/regression-report.md](templates/regression-report.md): regression triage report.
- [templates/release-readiness-checklist.md](templates/release-readiness-checklist.md): release-readiness artefact.

### Memory seeds (10)

- [memory-seeds/commit-style-conventional.md](memory-seeds/commit-style-conventional.md): conventional commits.
- [memory-seeds/dash-free-writing.md](memory-seeds/dash-free-writing.md): no-dashes rule seed.
- [memory-seeds/issue-discovery-posture.md](memory-seeds/issue-discovery-posture.md): intake posture; run issue-discovery before any dev-loop without an issue ref.
- [memory-seeds/ops-config-usage.md](memory-seeds/ops-config-usage.md): cite the keys you used.
- [memory-seeds/plan-lifecycle-moves.md](memory-seeds/plan-lifecycle-moves.md): plan lifecycle states + moves.
- [memory-seeds/planning-parallel-agents.md](memory-seeds/planning-parallel-agents.md): Phase-1 parallel Explore.
- [memory-seeds/swift-dst-day-count.md](memory-seeds/swift-dst-day-count.md): Swift DST-safe day counting.
- [memory-seeds/testing-discipline.md](memory-seeds/testing-discipline.md): test categories, results-table.
- [memory-seeds/wiki-scalable-layout.md](memory-seeds/wiki-scalable-layout.md): scalable nested wiki layout.
- [memory-seeds/xcui-combined-a11y.md](memory-seeds/xcui-combined-a11y.md): XCUITest combined-a11y gotcha.

## Don't-read list

For routine operations the agent should NOT load these end-to-end; they are heavy or one-shot:

- [AGENT.md](AGENT.md) (except the "Hard rules" section): the first-run bootstrap covers project setup; on sessions where a valid `ops.config.json` already exists, the bootstrap chapter is dead weight.
- [design/ARCHITECTURE.md](design/ARCHITECTURE.md): load only when debugging a structural question.
- [README.md](README.md) and [INSTALL.md](INSTALL.md): end-user / first-install facing.
- [skills/pr-iteration/runbook.md](skills/pr-iteration/runbook.md): load when the iteration loop hits a recipe-level question (e.g. how to capture the Copilot bot ID); otherwise `skills/pr-iteration/SKILL.md` + `rules/pr-iteration.md` are enough.

When routing between docs, prefer the SKILL.md (short contract) over the runbook (long how-to) unless the contract explicitly says "see the runbook".
