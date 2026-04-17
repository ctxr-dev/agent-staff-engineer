---
name: review-loop
description: The local review loop every change runs through before push: format, lint, type, unit, integration, e2e where applicable, then the code-review provider. No skipping, no early exit on green stages.
portable: true
scope: dev-loop, any automation that pushes a branch
---

# Local review loop

## The rule

Before a push to any feature branch, the agent runs the full local review loop. The loop is deterministic, ordered, and non-skippable:

1. Format
2. Lint
3. Type-check
4. Unit tests
5. Integration tests
6. e2e tests (only when the change touches an area listed in `workflow.pr.e2e_required_on`)
7. Code review (self-review via `workflow.code_review.provider`)

A failure at any stage halts the loop. The agent reports what failed, returns to the edit phase, and restarts from stage 1 after the fix. No `--skip-tests`, no "I know this is fine", no pushing through a red stage.

## Why the ordering matters

Format and lint catch mechanical issues cheaply. Type-check catches structural issues before runtime. Unit tests exercise isolated logic. Integration tests cover boundaries. e2e tests cover user flows. Self-review catches the class of issues automated tools miss.

Running cheap stages first minimises wasted time. Running every stage before push minimises wasted reviewer time downstream.

## Stage details

### Format

Runs the project's formatter in check-only mode first. If it would change anything, run it in write mode, commit the formatting as a separate commit (or amend depending on `workflow.commits.style`), re-enter the loop.

### Lint

Runs the project's linter. Warnings are reviewed; errors halt. Ignore rules in config, not inline, unless the user explicitly permits inline ignores for a specific case.

### Type-check

Runs per `stack.language`. TypeScript uses `tsc --noEmit`. Python uses `mypy` or the project's configured checker. Swift uses `swift build` in check mode. Go uses `go vet` plus `go build`. Same shape for other languages; the tool is chosen from `stack.*`.

### Unit + integration tests

Runs every suite listed in `workflow.pr.tests_required`. Default is `unit` and `integration`. A red test is a halt, even on a file the current change did not touch; such regressions are the loop's job to catch.

### e2e tests

Runs only when any area label on the issue is in `workflow.pr.e2e_required_on`. Test runner is chosen from `stack.testing`. e2e failures halt the loop the same way unit failures do.

### Code review

Runs per `workflow.code_review.provider`:

- Default `ctxr-skill-code-review`: invoke the external skill with `workflow.code_review.invocation` and `mode`. Parse the verdict. Verdict in `workflow.code_review.block_on_verdict` (default `NO-GO`) halts the loop.
- `internal-template`: render `templates/code-review-report.md` from the diff and fill it. The agent treats the artefact as a prompt to itself: any unresolved concern halts the loop.
- `none`: allowed only when `workflow.pr.self_review_required` is false. Skip this stage.

## When loops become infinite

A sign something is wrong: the loop fails, the agent fixes, the next loop fails differently, ad nauseam. The agent must recognise this and halt after three consecutive failed cycles on the same branch. Halt, surface the pattern, ask the user for guidance. Do not spin.

## Coverage vs speed

- Prefer the full loop. If a stage is slow (e2e on a large suite), the agent may filter to the change surface only when the user opts in via conversation, but never by default.
- Partial runs are annotated in the PR body and the self-review report. A reader can see which tests actually ran.

## Related rules

- [pr-workflow.md](pr-workflow.md)
- [github-source-of-truth.md](github-source-of-truth.md)
- The `testing-discipline.md` memory seed reinforces this on a per-project basis.
