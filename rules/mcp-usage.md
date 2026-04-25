---
name: mcp-usage
description: Governance rule for MCP server registration. Official-only servers, lazy registration, token-budget discipline, graceful degradation, security guardrails, freshness policy.
portable: true
scope: every session and every skill that declares mcp_required or mcp_optional
---

# MCP usage

## The rule

The bundle ships a conservative, official-only MCP integration layer. Every server in `mcp/manifest.yaml` is maintained by Anthropic or a first-party vendor, has active commits, broad adoption, and known-safe auth posture. Community MCPs are out of scope.

### Clause 1: lazy registration

Skills declare `mcp_required:` and `mcp_optional:` in their SKILL.md frontmatter. Core-tier servers (git, filesystem, sqlite) are always registered when the project's `mcp.tier` is `"core"` or `"core+observability"`. Optional-tier servers (datadog) activate only when their preconditions pass AND the consuming skill declares them.

### Clause 2: token-budget discipline

Each SKILL.md that declares an MCP must state expected schema overhead in a comment. The cache-control pass (#22) places server schemas inside the static cached block so they are not re-sent on every invocation.

### Clause 3: graceful degradation

Every skill that uses an MCP MUST have a fallback path using existing tools (`Bash`, `gh`, `Grep`, `Glob`, `Read`). No hard dependencies on MCP availability. When an MCP server is unavailable, the skill falls back silently and logs the fallback in its report.

### Clause 4: security and correctness guardrails

Any MCP requiring a secret loads it from the environment (e.g. `DATADOG_API_KEY`), never from `ops.config.json`. Official or first-party-vendor origin is necessary but not sufficient. Every first-party MCP is audited against the bundle's own requirements before inclusion.

### Clause 5: freshness policy

Server versions are tracked in `mcp/manifest.yaml`. Core servers use "latest" (npx resolves at install time from the GitHub-based registry; these reference servers are not published to npm with semver tags). Pin to a specific commit or tag when a known regression is discovered. Stale versions are flagged on session start (future: via remote-sync drift detection, #18).

## Rejected servers

| Server | Status | Reason |
|--------|--------|--------|
| `@modelcontextprotocol/server-memory` | rejected | Not team-shareable (JSON blob on one laptop). Replaced by the canonical knowledge store (#35): LLM Wiki as source of truth + SQLite MCP as local index. |
| `@github/mcp-server-github` | rejected (first-party) | All three reviewer tools (`update_pull_request`, `request_pull_request_reviewers`, `request_copilot_review`) call REST `RequestReviewers` internally. The REST endpoint silently no-ops for bot reviewers. No GraphQL `requestReviews` tool, no `call_graphql` escape hatch. Adopting it regresses every Copilot-review workflow. Our `gh` CLI path uses the working GraphQL `requestReviews` mutation with `botIds`. Revisit if upstream adds GraphQL reviewer support. |
| Community MCPs (code-graph-mcp, code-pathfinder, mcp-ripgrep, ts-refactoring-mcp) | rejected | Fail the "widely-supported + famous" bar. Skills like code-search and refactor-choreography use Claude Code native `Grep` / `Glob` / `Bash` in isolated subagents. Same ripgrep underneath, no fragile dependency. |

## Related

- [mcp/manifest.yaml](../mcp/manifest.yaml): the canonical server list with tiers and install commands.
- [rules/cache-economy.md](cache-economy.md): MCP server schemas live inside the cached static block.
- [rules/pr-iteration.md](pr-iteration.md): the `gh` CLI path that replaces the rejected GitHub MCP.
