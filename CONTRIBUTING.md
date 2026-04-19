# Contributing to agent-staff-engineer

Thanks for contributing. This bundle is zero-dependency at runtime and kept narrow by design. Keep those invariants intact.

## Setup

```bash
npm install
```

Dev dependencies are markdown linting only. The runtime bundle has no npm deps (enforced by `validate_bundle.mjs`).

## Layout

```text
agent-staff-engineer/
  AGENT.md                 Claude Code agent entry point
  skills/<name>/SKILL.md   Canonical skills (7)
  rules/*.md               Process rules (7; product-*.md are project-specific, not in the bundle)
  memory-seeds/*.md        Generic memory starter entries
  templates/*.md           Issue, PR, report templates with placeholders
  schemas/ops.config.schema.json  Strict contract every skill reads
  scripts/                 Node ESM installer, bootstrap, adapt, seed installer, validator, preflight, update_self
  scripts/lib/             shared helpers (agentName, fsx, gitignore, inject, schema, wrapper, diff, argv, ghExec)
  examples/                Fully-populated fictitious example config
  tests/                   node:test unit + E2E tests
  design/                  MASTER-PLAN, DECISIONS, ARCHITECTURE, OPEN-QUESTIONS, RISKS
```

## Development workflow

### Local checks

```bash
npm run preflight         # confirm Node 20+
npm run validate          # portability gate: no project literals, schema consistency, zero-deps check
npm run lint              # markdownlint across every .md
npm test                  # node:test unit + E2E
```

All four must pass before opening a PR.

### Hard rules (enforced by `validate_bundle.mjs`)

- No em or en dashes in authored markdown. See `rules/no-dashes.md`. Fenced code blocks are exempt.
- No project-specific literals (cafeiner, caffeinic, healthkit, ...) anywhere outside the validator itself.
- Every SKILL.md carries a `## Project contract` section listing its `ops.config.json` keys.
- Every rule has `portable: true` in frontmatter (unless it sits under `rules/product-*.md`, which is project-specific and not shipped).
- Every memory seed has frontmatter with `type`, `portable: true`, and a `tags` block.
- Every `.mjs` under `scripts/` imports only `node:*` builtins or relative paths. No bare imports, no `package.json` inside `scripts/`.

### Adding a skill

1. Create `skills/<new-skill>/SKILL.md` with frontmatter: `name`, `description`, `trigger_on`, `do_not_trigger_on`, `writes_to_github`, `writes_to_filesystem`.
2. Body must include a `## Project contract` section listing the `ops.config.json` keys it reads.
3. Run `npm run validate` to confirm structure.
4. Open a PR.

### Adding a rule

1. Create `rules/<new-rule>.md` with frontmatter: `name`, `description`, `portable: true`, `scope`.
2. No em or en dashes anywhere in the body.
3. Cross-link from at least one other rule's "Related rules" section if relevant.

### Adding a memory seed

1. Create `memory-seeds/<slug>.md` with frontmatter: `name`, `description`, `type` (usually `feedback`), `portable: true`, `tags` (empty for universal seeds, otherwise `language`, `testing`, `platform`).
2. Keep the body tight; memory seeds are reference material, not long essays.
3. If the seed uses `{{ placeholder }}` references to `ops.config.json` keys, list them under a `placeholders:` key in frontmatter.

## Testing

Unit and E2E tests live under `tests/` and run with Node's built-in test runner:

```bash
node --test tests/*.test.mjs
```

- Unit tests cover `scripts/lib/` helpers and the marker-merge logic.
- E2E tests run the installer against a throwaway scratch directory under `/tmp`, never touching any real project.

## Releasing

Releases are PR-gated; the bot does not push to `main` directly. One dispatch + one PR merge + one dispatch ships the package.

1. **Actions → Release → Run workflow**. Branch selector: `main` (any other ref is rejected). Version bump: `patch` / `minor` / `major`.
2. The workflow bumps `package.json` (and `npm-shrinkwrap.json` when present) on a `release/v<version>` branch and opens a release PR.
3. Review + merge the PR.
4. `tag-on-main.yml` detects the version change on the merge commit, creates the annotated `v<version>` tag, and pushes it.
5. **Actions → Publish to npm → Run workflow** on the new `v<version>` tag. The workflow runs `npm ci + preflight + validate + lint + test`, verifies tag/version agreement, and runs `npm publish --access public --provenance`.

The tag push does NOT auto-chain into publish: `GITHUB_TOKEN` cannot trigger further workflows. Step 5 is a manual dispatch until a GitHub App token or fine-grained PAT is wired into `tag-on-main.yml`'s tag-push step.

Full operator walkthrough (including troubleshooting for stale or orphan tags, non-main dispatches, and the "Allow GitHub Actions to create and approve pull requests" org-level policy) lives in the [Releasing section of the README](README.md#releasing).

## Questions

Open an issue or a PR. Keep PRs focused; one change per PR keeps review fast.
