# Changelog

All notable changes to `@ctxr/agent-staff-engineer` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-05-29

### Changed

- Pinned the `npx @ctxr/kit` commands run and printed by the runtime scripts (`bootstrap`, `install`, `update_self`, `waitForSkill`, `lib/fsx`) to `npx @ctxr/kit@latest`, so they resolve reliably on newer npm where an unpinned scoped npx spec can fail to link its bin. The install-hint test assertion was updated to match.

## [1.0.4] - 2026-05-29

### Changed

- Pinned every documented `npx @ctxr/kit` invocation (README, INSTALL, rules, schemas, skills, examples) to `npx @ctxr/kit@latest`.

Versions 1.0.0 through 1.0.3 (2026-04-17 to 2026-04-18) predate this changelog.
