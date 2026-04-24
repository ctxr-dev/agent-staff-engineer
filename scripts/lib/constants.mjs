// lib/constants.mjs
// Shared string constants used across multiple scripts.
// Extract here when a value appears in 2+ code files to prevent
// silent drift and make renames a single-point change.

/** The external code-review skill provider token (ops.config key and kit skill directory name). */
export const CODE_REVIEW_SKILL = "ctxr-skill-code-review";

/** The built-in fallback code-review provider. */
export const CODE_REVIEW_INTERNAL = "internal-template";

/** Provider value that disables code review entirely. */
export const CODE_REVIEW_NONE = "none";

/** All valid code-review provider values. */
export const CODE_REVIEW_PROVIDERS = [CODE_REVIEW_SKILL, CODE_REVIEW_INTERNAL, CODE_REVIEW_NONE];
