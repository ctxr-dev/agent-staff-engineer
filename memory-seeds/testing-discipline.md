---
name: Testing discipline
description: Test categories, no mocks at the integration boundary, results-table reporting format for this project.
type: feedback
portable: true
tags: []
placeholders:
  - "{{ workflow.pr.tests_required }}"
  - "{{ workflow.pr.e2e_required_on }}"
  - "{{ stack.testing }}"
---

Testing on this project follows four consistent habits, enforced by `rules/review-loop.md` and the `dev-loop` skill.

1. **Run categories configured in `ops.config.json -> workflow.pr.tests_required`** before any push. Default: unit and integration.
2. **Run e2e when the change touches any area listed in `workflow.pr.e2e_required_on`.** e2e test runner is selected from `stack.testing`.
3. **No mocks at the integration boundary.** Integration tests hit real dependencies (real database, real file I/O, real local services). Mocks are reserved for unit tests of isolated logic.
4. **Report results as a table**, not a paragraph. For multi-suite or multi-flow runs, show per-suite pass/fail counts plus duration, never a vague "all green".

**Why:** mocking at the integration boundary has repeatedly masked real bugs in migrations, schema changes, and cross-service contracts. The table format keeps session-to-session reports directly comparable.

**How to apply:**

- Before opening a PR, run every required test category locally. Do not rely on CI to catch what a local run would.
- If e2e is required, run the flows that cover the changed area; do not rely on "probably fine".
- For tests that require real dependencies, document setup steps in the project's runbooks under `{{ paths.runbooks }}`.
- For any multi-suite or multi-flow test execution, render a results table at the end of your turn: columns for suite, scenarios, passed, failed, duration.

When a test is hard to write because a control is hard to reach, prefer injecting data at the boundary over mocking out the subject under test.
