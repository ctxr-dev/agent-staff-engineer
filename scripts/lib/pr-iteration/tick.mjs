// lib/pr-iteration/tick.mjs
// One-shot tick for the wakeup-driven PR iteration loop.
//
// Each tick:
//   1. Checks for a .stopped sidecar (user cancelled).
//   2. Team path: polls remote state via tracker.review.pollForReview.
//      Solo path: uses caller-provided ciState (no remote poll).
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
 * Normalize a CI state value to the schema-allowed enum.
 * Folds unknown values to "PENDING" to prevent schema validation
 * failures on the next readPrState.
 */
function normalizeCiState(raw) {
  if (raw === "SUCCESS" || raw === "FAILURE" || raw === "ERROR" || raw === "PENDING") {
    return raw;
  }
  return "PENDING";
}

/**
 * Run one tick of the PR iteration loop.
 *
 * @param {object} tracker     tracker object with a .review namespace (unused on solo path)
 * @param {object} state       validated PR iteration state (mutated in place)
 * @param {object} opts
 * @param {string} opts.stateDir           absolute path to the state directory
 * @param {number} [opts.maxConsecutiveWakes=96]  safety cap before auto-pause
 * @param {boolean} [opts.soloPath=false]  true when workflow.external_review.provider is "none";
 *                                         skips pollForReview and uses relaxed exit conditions
 * @param {string} [opts.ciState]          CI status for the solo path; one of "SUCCESS",
 *                                         "FAILURE", "ERROR", "PENDING". Caller fetches this
 *                                         independently (e.g. via gh api graphql). Ignored on
 *                                         the team path where pollForReview provides CI state.
 * @returns {Promise<{done: boolean, action: string, state: object}>}
 *   action is one of:
 *     "complete"        all three exit conditions hold; state file removed
 *     "solo-ready"      solo path: localReviewGo + ciSuccess hold; skill should prompt merge
 *     "needs-triage"    CI terminal + threads/review arrived; skill should fix
 *     "still-waiting"   CI pending or no review yet; reschedule
 *     "user-cancelled"  .stopped sidecar found; no remote call made
 *     "paused"          .paused sidecar found; no remote call made
 *     "safety-cap"      consecutive-wakes cap reached; .paused written
 */
export async function runTick(tracker, state, opts) {
  const {
    stateDir,
    maxConsecutiveWakes = DEFAULT_MAX_CONSECUTIVE_WAKES,
    soloPath = false,
    ciState: soloCiState,
  } = opts;

  // ── 1. User-cancel / paused gates ──
  if (await isStateStopped(stateDir, state.prId)) {
    return { done: true, action: "user-cancelled", state };
  }
  if (await isStatePaused(stateDir, state.prId)) {
    return { done: true, action: "paused", state };
  }

  // ── 2. Solo path: no external review, relaxed exit conditions ──
  // When workflow.external_review.provider is "none", the caller sets
  // soloPath=true and passes ciState directly (fetched via gh api).
  // No pollForReview call (the stub tracker would throw).
  // Exit set: localReviewGo + ciSuccessOnHead. No zeroUnresolvedOnHead.
  // Returns "solo-ready" when both hold; the skill layer prompts the user.
  if (soloPath) {
    if (soloCiState === undefined || soloCiState === null) {
      throw new TypeError(
        "runTick: soloPath requires opts.ciState (caller must fetch CI status independently)",
      );
    }
    const ciNow = normalizeCiState(soloCiState);
    state.lastPollResult = {
      ciState: ciNow,
      unresolvedCount: 0,
      reviewOnHead: false,
      observedAt: new Date().toISOString(),
    };
    state.exitConditions.ciSuccessOnHead = ciNow === "SUCCESS";
    state.exitConditions.zeroUnresolvedOnHead = false;

    if (state.exitConditions.localReviewGo && state.exitConditions.ciSuccessOnHead) {
      // Increment consecutiveWakes even on solo-ready so the safety cap
      // triggers if the user keeps deferring merge ("Not yet").
      state.consecutiveWakes = (state.consecutiveWakes ?? 0) + 1;
      if (state.consecutiveWakes >= maxConsecutiveWakes) {
        await markPrStatePaused(
          stateDir,
          state.prId,
          `Safety cap reached: ${maxConsecutiveWakes} consecutive wakes without merge`,
        );
        await writePrState(stateDir, state);
        return { done: true, action: "safety-cap", state };
      }
      await writePrState(stateDir, state);
      return { done: false, action: "solo-ready", state };
    }

    const ciFailed = ciNow === "FAILURE" || ciNow === "ERROR";
    if (ciFailed) {
      state.consecutiveWakes = 0;
      await writePrState(stateDir, state);
      return { done: false, action: "needs-triage", state };
    }

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

  // ── 3. Team path: single remote poll ──
  const ctx = buildCtx(state);
  const pollResult = await tracker.review.pollForReview(ctx);

  // ── 4. Update state with poll results ──
  state.lastPollResult = {
    ciState: pollResult.ciState,
    unresolvedCount: pollResult.unresolvedCount,
    reviewOnHead: pollResult.reviewOnHead,
    observedAt: new Date().toISOString(),
  };
  state.exitConditions.ciSuccessOnHead = pollResult.ciState === "SUCCESS";
  state.exitConditions.zeroUnresolvedOnHead =
    pollResult.unresolvedCount === 0 && pollResult.reviewOnHead;

  // ── 5. All exit conditions green? ──
  const allGreen =
    state.exitConditions.localReviewGo &&
    state.exitConditions.zeroUnresolvedOnHead &&
    state.exitConditions.ciSuccessOnHead;

  if (allGreen) {
    await removePrState(stateDir, state.prId);
    return { done: true, action: "complete", state };
  }

  // ── 6. Needs triage? ──
  // CI failure/error always needs triage (rule: "CI goes red: fix, re-push").
  // CI success with threads or review also needs triage.
  const ciFailed =
    pollResult.ciState === "FAILURE" || pollResult.ciState === "ERROR";
  const ciTerminal = pollResult.ciState !== "PENDING";
  const hasActivity =
    pollResult.unresolvedCount > 0 || pollResult.reviewOnHead;

  if (ciFailed || (ciTerminal && hasActivity)) {
    state.consecutiveWakes = 0;
    await writePrState(stateDir, state);
    return { done: false, action: "needs-triage", state };
  }

  // ── 7. Still waiting; bump consecutive-wakes counter ──
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
