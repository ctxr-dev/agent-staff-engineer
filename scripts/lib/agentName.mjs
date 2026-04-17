// lib/agentName.mjs
// Single source of truth for the agent's prefix. Derived from the bundle's
// `package.json -> name` by stripping the npm scope (`@scope/`).
//
// Example: "@ctxr/agent-staff-engineer" -> "agent-staff-engineer".
//
// The prefix is used on wrapper filenames the installer writes into the
// target project (e.g. `.claude/rules/agent-staff-engineer_pr-workflow.md`)
// so those files do not collide with wrappers from other agents/skills that
// ship rules or memory seeds with the same short name. Canonical files
// inside the bundle (`<bundle>/rules/pr-workflow.md`) keep their short names
// and are NOT prefixed.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PREFIX_SEPARATOR = "_";

/**
 * @param {string} bundleAbs absolute path to the bundle root
 * @returns {Promise<{ prefix: string, packageName: string, separator: string }>}
 */
export async function getAgentPrefix(bundleAbs) {
  const text = await readFile(join(bundleAbs, "package.json"), "utf8");
  const pkg = JSON.parse(text);
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new Error(
      `agentName: package.json at ${bundleAbs} has no usable "name" field. The installer needs it to derive the wrapper prefix.`
    );
  }
  return {
    prefix: derivePrefix(pkg.name),
    packageName: pkg.name,
    separator: PREFIX_SEPARATOR,
  };
}

/**
 * Strip the npm scope (`@scope/`) and return the remainder. Exported for tests
 * and for any caller that already has the package name in memory.
 * @param {string} packageName
 */
export function derivePrefix(packageName) {
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error("derivePrefix: package name must be a non-empty string");
  }
  const slash = packageName.indexOf("/");
  if (packageName.startsWith("@") && slash > 0) {
    return packageName.slice(slash + 1);
  }
  return packageName;
}

/** Returns the canonical wrapper-filename form: "<prefix>_<short>". */
export function prefixed(prefix, shortName) {
  return `${prefix}${PREFIX_SEPARATOR}${shortName}`;
}

export { PREFIX_SEPARATOR };
