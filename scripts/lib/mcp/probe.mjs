// lib/mcp/probe.mjs
// Detect MCP preconditions from the environment.
// Never persists secrets to disk.

/**
 * Probe the environment for MCP preconditions.
 * Returns { datadogAvailable: boolean }.
 */
export function probeEnvironment() {
  const ddKey = process.env.DATADOG_API_KEY;
  return {
    datadogAvailable: typeof ddKey === "string" && ddKey.length > 0,
  };
}

/**
 * Determine the effective MCP tier based on config + environment.
 * @param {string} configuredTier - from ops.config.json mcp.tier ("core" | "core+observability" | "none")
 * @param {object} env - result of probeEnvironment()
 * @returns {string} effective tier
 */
export function resolveEffectiveTier(configuredTier, env) {
  if (configuredTier === "none") return "none";
  if (configuredTier === "core+observability") {
    return env.datadogAvailable ? "core+observability" : "core";
  }
  return "core";
}
