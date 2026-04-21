// lib/pr-iteration/tick.mjs
// One-shot tick for the wakeup-driven PR iteration loop.
//
// Each tick:
//   1. Checks for a .stopped sidecar (user cancelled).
//   2. Polls remote state once via tracker.review.pollForReview.
//   3. Updates exit conditions.
//   4. Returns an action the skill caller acts on.
//
// The tick never does fixes, commits, or pushes. That is the skill's job
// based on the returned action. The tick is purely a "check and report"
// function.

import {
  isStatePaused,
  isStateStopped,
  markPrStatePaused,
  removePrState,
  writePrState,
} from "./state.mjs";

const DEFAULT_MAX_CONSECUTIVE_WAKES = 96;

/**
 * Build the tracker context object from persisted state.
 * @param {object} state validated PR iteration state
 * @returns {object} ctx suitable for tracker.review.* methods
 */
function buildCtx(state) {
  return {
    owner: state.owner,
    repo: state.repo,
    prNumber: state.prNumber,
    prNodeId: state.prNodeId,
    headSha: state.headSha,
    botIds: state.botIds,
    botLogins: state.botLogins,
  };
}

/**
 * Run one tick of the PR iteration loop.
 *
 * @param {object} tracker     tracker object with a .review namespace
 * @param {object} state       validated PR iteration state (mutated in place)
 * @param {object} opts
 * @param {string} opts.stateDir           absolute path to the state directory
 * @param {number} [opts.maxConsecutiveWakes=96]  safety cap before auto-pause
 * @returns {Promise<{done: boolean, action: string, state: object}>}
 *   action is one of:
 *     "complete"        all three exit conditions hold; state file removed
 *     "needs-triage"    CI terminal + threads/review arrived; skill should fix
 *     "still-waiting"   CI pending or no review yet; reschedule
 *     "user-cancelled"  .stopped sidecar found; no remote call made
 *     "paused"          .paused sidecar found; no remote call made
 *     "safety-cap"      consecutive-wakes cap reached; .paused written
 */
export async function runTick(tracker, state, opts) {
  const { stateDir, maxConsecutiveWakes = DEFAULT_MAX_CONSECUTIVE_WAKES } = opts;

  // ── 1. User-cancel / paused gates ──
  if (await isStateStopped(stateDir, state.prId)) {
    return { done: true, action: "user-cancelled", state };
  }
  if (await isStatePaused(stateDir, state.prId)) {
    return { done: true, action: "paused", state };
  }

  // ── 2. Single remote poll ──
  const ctx = buildCtx(state);
  const pollResult = await tracker.review.pollForReview(ctx);

  // ── 3. Update state with poll results ──
  state.lastPollResult = {
    ciState: pollResult.ciState,
    unresolvedCount: pollResult.unresolvedCount,
    reviewOnHead: pollResult.reviewOnHead,
    observedAt: new Date().toISOString(),
  };
  state.exitConditions.ciSuccessOnHead = pollResult.ciState === "SUCCESS";
  state.exitConditions.zeroUnresolvedOnHead =
    pollResult.unresolvedCount === 0 && pollResult.reviewOnHead;

  // ── 4. All exit conditions green? ──
  const allGreen =
    state.exitConditions.localReviewGo &&
    state.exitConditions.zeroUnresolvedOnHead &&
    state.exitConditions.ciSuccessOnHead;

  if (allGreen) {
    await removePrState(stateDir, state.prId);
    return { done: true, action: "complete", state };
  }

  // ── 5. Needs triage? (CI terminal AND new threads or review arrived) ──
  const ciTerminal = pollResult.ciState !== "PENDING";
  const hasActivity =
    pollResult.unresolvedCount > 0 || pollResult.reviewOnHead;

  if (ciTerminal && hasActivity) {
    state.consecutiveWakes = 0;
    await writePrState(stateDir, state);
    return { done: false, action: "needs-triage", state };
  }

  // ── 6. Still waiting; bump consecutive-wakes counter ──
  state.consecutiveWakes = (state.consecutiveWakes ?? 0) + 1;

  if (state.consecutiveWakes >= maxConsecutiveWakes) {
    await markPrStatePaused(
      stateDir,
      state.prId,
      `Safety cap reached: ${maxConsecutiveWakes} consecutive wakes without forward progress`,
    );
    await writePrState(stateDir, state);
    return { done: true, action: "safety-cap", state };
  }

  await writePrState(stateDir, state);
  return { done: false, action: "still-waiting", state };
}
