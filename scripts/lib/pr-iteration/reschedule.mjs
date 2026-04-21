// lib/pr-iteration/reschedule.mjs
// Helpers for scheduling the next wakeup tick. Pure functions; the actual
// ScheduleWakeup tool call happens in the skill layer, not here.

const DEFAULT_INTERVAL = 270;
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 3600;

/**
 * Compute the wakeup interval in seconds.
 *
 * Priority: explicit user override > state.intervalSeconds > config default > 270s.
 * Result is clamped to [60, 3600] (ScheduleWakeup's enforced range).
 *
 * @param {number|null|undefined} userOverrideSeconds  free-form user request (e.g. "10 min" parsed to 600)
 * @param {object} [state]                             persisted PR iteration state
 * @param {number} [configDefault]                     workflow.external_review.autonomous.default_interval_seconds
 * @returns {number} clamped interval in seconds
 */
export function computeInterval(userOverrideSeconds, state, configDefault) {
  const raw =
    userOverrideSeconds ??
    state?.intervalSeconds ??
    configDefault ??
    DEFAULT_INTERVAL;
  return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, raw));
}

/**
 * Build the prompt string for ScheduleWakeup.
 * The agent re-enters on wake with this prompt and reads the state file.
 *
 * @param {object} state  persisted PR iteration state
 * @returns {string} prompt for the wakeup
 */
export function buildWakeupPrompt(state) {
  return `/resume-pr-iteration ${state.prId}`;
}

/**
 * Build the human-readable reason string for ScheduleWakeup.
 *
 * @param {object} state  persisted PR iteration state
 * @returns {string}
 */
export function buildWakeupReason(state) {
  const ci = state.lastPollResult?.ciState ?? "unknown";
  const threads = state.lastPollResult?.unresolvedCount ?? "?";
  return `Checking PR ${state.prId} (CI: ${ci}, unresolved: ${threads})`;
}
