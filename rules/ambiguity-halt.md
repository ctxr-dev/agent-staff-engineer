---
name: ambiguity-halt
description: When any skill notices state it cannot classify deterministically (local vs remote divergence, orphan PRs, status contradictions, unexplained branches), halt and ask the user. Never guess; never take a mutating action while the question is open.
portable: true
scope: every skill that mutates state on GitHub or on the local filesystem
---

# Ambiguity halt

## The rule

If a skill is about to act on a reference (branch, PR, issue, plan file) and notices state it cannot classify deterministically as "proceed as-is" or "archived / no-longer-relevant", the skill:

1. **Halts** before any mutating action.
2. **Surfaces** the ambiguity in one short sentence per observation, using the message shape below.
3. **Asks** the user how to proceed.
4. **Resumes** only after the user's answer.

The contract standardises how every skill behaves once ambiguity is noticed. It is not a detector hook: each skill decides WHEN to check; this rule defines WHAT to do after the check says "weird".

## Message shape

One sentence per ambiguity. Plain English. No jargon unless it is the tracker's own vocabulary (PR, issue, branch, commit). No apology framing, no filler.

```text
I see <observation> on <reference>. <hypothesis, if any>. How do you want me to proceed?
```

If there are multiple ambiguities, list them as bullets under a single question; do not ask N times.

Example for one:

```text
I see an open PR (#42) on issue #17, but the branch (feat/17-x) does not exist locally.
Likely a teammate opened it from another machine. How do you want me to proceed?
```

Example for several:

```text
Before proceeding I noticed some things I cannot classify:
- Branch feat/17-x has 3 unpushed commits none of which match any open PR.
- Issue #17 is closed, but the plan one-liner still shows `[ ]`.
How do you want me to proceed?
```

## Hard never-do list while waiting

While the question is open, the skill MUST NOT:

- Push to any remote (code, tags, release assets).
- Publish a tag or a GitHub Release.
- Open / edit / close / merge a PR.
- Add / edit / resolve a review thread.
- Add / edit / close / reopen / relabel / reassign / move status on an issue.
- Delete or rename a local or remote branch.
- Delete or rename any file the user did not ask about.
- Invoke `@ctxr/skill-llm-wiki` to extend / rebuild / fix any wiki under `.development/**` (writes into a wiki surface are mutations from the user's perspective).
- Apply an adapt-system cascade diff (even when previewed and the user has approved a SIBLING diff; ambiguity on one target invalidates the session-level approval).

Read-only work (local file reads, `git fetch`, `git status`, `gh` read queries, `skill-llm-wiki validate` read probes) stays allowed. The agent MAY gather more context to improve the question before asking.

## What counts as "ambiguous"

Examples per skill, indicative, not exhaustive:

- **dev-loop**: dev issue already has an open PR whose branch is unknown locally; user asked to branch from a non-default branch without stating why; the code change would collide with an unmerged sibling PR on the same files.
- **pr-iteration**: a review thread author is neither a configured bot nor the project owner AND the comment contradicts a prior commit of the loop; the PR's HEAD advanced while the round was in-flight (someone else pushed).
- **regression-handler**: the bug issue the user referenced is already closed with a resolution comment; a candidate "best match" matches multiple recently-closed issues with near-equal scores.
- **adapt-system**: the proposed diff would touch a file the validator flags as hand-authored (e.g. `bundle-index.md`, `.gitignore`, `CLAUDE.md` above the managed marker); two different user intents in the same session would cascade to contradictory labels.
- **plan-keeper**: a plan one-liner flip would contradict the PR's current status as reported by `github-sync` (plan says `[x]`, PR says "In progress").

Each skill's SKILL.md lists its specific trigger conditions. The list above is for orientation; skills own the truth.

## Resume protocol

After the user answers:

- If the user says "proceed as-is" (or equivalent), the skill continues from where it halted.
- If the user gives a new direction, the skill treats that as the authoritative intent and re-plans from there.
- If the user says "stop", the skill exits cleanly without mutating anything.

No silent resumption. The skill always confirms in one sentence what it understood before acting ("Okay: proceeding with merge of #42; leaving branch feat/17-x alone.").

## Related

- [rules/github-source-of-truth.md](github-source-of-truth.md): GitHub is authoritative; local files are projections. Ambiguity is usually a local-vs-remote divergence.
- [rules/pr-workflow.md](pr-workflow.md): the two human gates (merge, Done) are absolute. This rule adds a third class of halt: anything weird.
- [rules/pr-iteration.md](pr-iteration.md): iteration loop invokes this contract when the three exit conditions cannot be determined.
- [bundle-index.md](../bundle-index.md): routing doc; this rule is referenced from the "Iterating on review comments", "Triaging a regression", "Writing / keeping plans in sync", and "Bootstrap + config changes" intents.
