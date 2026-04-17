---
name: adaptation
description: When the user describes the project in a shape-changing way, invoke adapt-system and propose a cascading diff. Never silently encode a new project fact in one spot.
portable: true
scope: every session running on a project that installed this agent
---

# Adaptation is continuous

## The rule

When the user describes the project in a way that **changes its shape**, the session treats it as an adaptation signal. Invoke `adapt-system` with the intent. The skill produces a unified diff across configuration, labels, templates, rules, and memory seeds. The user approves; the skill applies.

Do not silently encode a new project fact in a single file. If a signal matters, it matters across several places. A fact that lives in only one spot drifts.

## What counts as a shape-changing signal

- **Domain**: "we handle PHI now", "this is a medical-device-adjacent product", "we're a payments processor".
- **Compliance**: "we need HIPAA compliance", "drop GDPR, not applicable in our market", "add SOC2 type II".
- **Stack**: "we added a Chrome extension target", "we dropped TelemetryDeck for PostHog", "we're migrating from Python to Go".
- **Audience**: "this is B2B now, enterprise customers", "consumer launch next month".
- **Cadence**: "moving from per-wave to continuous deploys", "adding a monthly release train".
- **Scope**: "we are now also tracking the sibling repo for regressions", "drop the shared-lib observation".

## What does not count

- Day-to-day work on an issue. That is `dev-loop`, not `adapt-system`.
- A question about a file. Answer it, do not cascade.
- A one-off fact that will not recur ("this customer asked for a feature"). Capture it as a project memory entry, not as a system change.
- A correction to the last sentence ("I meant to say X"). Treat as conversational, not adaptive.

## How to recognise a signal

Ask yourself three questions:

1. Will this fact be true tomorrow?
2. Does it affect more than one file in the bundle (config, labels, templates, rules, seeds)?
3. Does following the fact require work across multiple skills?

A "yes" to any two of the three is probably a shape-changing signal.

## What the agent must do

1. Acknowledge the signal explicitly. Example: "That sounds like an adaptation: compliance:hipaa. Want me to run adapt-system to propose the cascade?"
2. Invoke `adapt-system` with the interpreted intent plus the original user quote.
3. Present the unified diff. Narrate each change with a one-line tie back to the signal.
4. Wait for approval. Accept edits.
5. On approval, apply the cascade. On refusal of specific pieces, apply the rest or halt per the user's choice.

## What the agent must not do

- Silently add a label.
- Silently edit a rule.
- Silently install a memory seed.
- Add a TODO or a note in one file and call it "captured". One-spot capture is the failure mode this rule exists to prevent.

## Cascade targets (summary)

- `ops.config.json -> compliance.*, stack.*, labels.*, area_keywords, workflow.phase_term`.
- `labels.*` on every configured GitHub target (through `github-sync`).
- `templates/*.md` sections added, removed, or reworded.
- `rules/product-*.md` created or removed (frontmatter `portable: false`).
- Memory seeds installed or deprecated on the target's memory folder.

Full mapping lives in `skills/adapt-system/SKILL.md`.

## Idempotency

A signal delivered twice with the same content produces no-op diffs the second time. If the first run was partial (user approved some changes, rejected others), the second run proposes only the remaining pieces.

## Contradictions

A signal that reverses an earlier adaptation is explicit and is handled. Example: "we dropped the legacy analytics SDK". The cascade includes removal of the related area labels, deprecation of related templates sections, and a list of any open GitHub issues tagged with the removed label so the user can reassign or close them. The historical `.bootstrap-answers.json` entry and any `.install-manifest.json` records of the earlier adaptation stay intact; the audit trail is preserved.

## Related rules

- [github-source-of-truth.md](github-source-of-truth.md): labels and issues on GitHub are part of the cascade.
- [memory-hygiene.md](memory-hygiene.md): seeds installed via adaptation are treated the same as bootstrap seeds.
- [no-dashes.md](no-dashes.md): applies to every authored surface the cascade touches.
