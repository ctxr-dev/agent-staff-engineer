// lib/mcp/register.mjs
// Reads mcp/manifest.yaml and writes a project-level .mcp.json
// with the servers appropriate for the configured tier.

import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "../fsx.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { probeEnvironment, resolveEffectiveTier } from "./probe.mjs";

const require = createRequire(import.meta.url);
const { load: yamlLoad } = require("js-yaml");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "..", "..", "mcp", "manifest.yaml");

/**
 * Load and parse the MCP manifest. Validates the required top-level keys.
 */
export async function loadManifest(manifestPath = MANIFEST_PATH) {
  const content = await readFile(manifestPath, "utf8");
  const doc = yamlLoad(content);
  if (!doc || !doc.servers || typeof doc.servers !== "object" || Array.isArray(doc.servers)) {
    throw new TypeError("MCP manifest must have a top-level 'servers' object");
  }
  return doc;
}

/**
 * Build the list of servers to register based on the effective tier.
 * Returns array of { name, server config }.
 */
export function selectServers(manifest, effectiveTier) {
  if (effectiveTier === "none") return [];

  const servers = [];
  for (const [name, def] of Object.entries(manifest.servers ?? {})) {
    if (def.tier === "core") {
      servers.push({ name, ...def });
    } else if (def.tier === "observability" && effectiveTier === "core+observability") {
      servers.push({ name, ...def });
    }
  }
  return servers;
}

/**
 * Build the .mcp.json content for the selected servers.
 * Format follows Claude Code's MCP configuration schema.
 */
export function buildMcpConfig(servers, targetDir) {
  const mcpServers = {};
  for (const server of servers) {
    // Only auto-register servers with scoped npm packages (@org/pkg)
    // that can be launched via npx. Vendor-specific servers (datadog)
    // require manual setup per their docs and are reported as "skipped"
    // in the install output. The tier config records the INTENT
    // (core+observability); actual datadog activation is manual.
    if (!server.package || !server.package.startsWith("@")) continue;
    mcpServers[server.name] = {
      command: "npx",
      args: ["-y", server.package, ...(server.name === "filesystem" ? [targetDir] : [])],
    };
  }
  return { mcpServers };
}

/**
 * Write .mcp.json to the target project.
 * Merges with existing entries (preserves user-added servers).
 */
export async function writeMcpJson(targetDir, mcpConfig) {
  const mcpJsonPath = join(targetDir, ".mcp.json");
  let existing = {};
  try {
    existing = JSON.parse(await readFile(mcpJsonPath, "utf8"));
  } catch {
    // No existing .mcp.json or parse error; start fresh.
  }

  const existingServers = (existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers))
    ? existing.mcpServers
    : {};
  const merged = {
    ...existing,
    mcpServers: {
      ...existingServers,
      ...mcpConfig.mcpServers,
    },
  };

  await atomicWriteJson(mcpJsonPath, merged);
  return mcpJsonPath;
}

/**
 * Full registration flow: load manifest, probe env, select servers, write config.
 * Returns { tier, servers, mcpJsonPath }.
 */
export async function registerMcpServers(targetDir, configuredTier = "core", manifestPath = MANIFEST_PATH) {
  const manifest = await loadManifest(manifestPath);
  const env = probeEnvironment();
  const tier = resolveEffectiveTier(configuredTier, env);
  const servers = selectServers(manifest, tier);

  if (servers.length === 0) {
    return { tier, servers: [], mcpJsonPath: null };
  }

  const mcpConfig = buildMcpConfig(servers, targetDir);
  const registeredNames = Object.keys(mcpConfig.mcpServers);
  const skippedNames = servers.filter((s) => !registeredNames.includes(s.name)).map((s) => s.name);

  if (registeredNames.length === 0) {
    return { tier, servers: [], skipped: skippedNames, mcpJsonPath: null };
  }

  const mcpJsonPath = await writeMcpJson(targetDir, mcpConfig);
  return { tier, servers: registeredNames, skipped: skippedNames, mcpJsonPath };
}
