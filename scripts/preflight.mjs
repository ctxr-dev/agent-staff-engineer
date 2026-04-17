#!/usr/bin/env node
// preflight.mjs
// Verify Node.js version before any other bundle script runs. Every script
// starts with `await preflight()`; running this file directly prints the
// detected state and exits.
// Requires Node 20+ (top-level await, native test runner, stable fs/promises).

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MIN_NODE_MAJOR = 20;

/**
 * @returns {{ ok: boolean, currentMajor: number, current: string, required: number, platform: string }}
 */
export function detectNode() {
  const current = process.version; // e.g. "v25.9.0"
  const match = current.match(/^v(\d+)/);
  const currentMajor = match ? Number(match[1]) : 0;
  return {
    ok: currentMajor >= MIN_NODE_MAJOR,
    currentMajor,
    current,
    required: MIN_NODE_MAJOR,
    platform: process.platform,
  };
}

/** Human-readable installation guidance per platform. */
export function installGuidance(platform) {
  switch (platform) {
    case "darwin":
      return [
        "macOS: install a recent Node via Homebrew:",
        "  brew install node",
        "or via nvm:",
        "  nvm install --lts",
        "",
        "Verify: node --version",
      ].join("\n");
    case "linux":
      return [
        "Linux: install via nvm (recommended for per-user setup):",
        "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash",
        "  source ~/.nvm/nvm.sh && nvm install --lts",
        "or via your distribution package manager (apt, dnf, pacman).",
        "",
        "Verify: node --version",
      ].join("\n");
    case "win32":
      return [
        "Windows: install via winget:",
        "  winget install OpenJS.NodeJS",
        "or via nvm-windows (https://github.com/coreybutler/nvm-windows).",
        "",
        "Verify: node --version",
      ].join("\n");
    default:
      return `Unknown platform (${platform}). Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org/.`;
  }
}

/** Attempt a supported install on the user's platform. Only runs when --auto-install-node is given. */
export function autoInstall(platform) {
  switch (platform) {
    case "darwin": {
      // Prefer Homebrew if available.
      const check = spawnSync("command", ["-v", "brew"], { encoding: "utf8", shell: "/bin/sh" });
      if (check.status === 0 && check.stdout.trim()) {
        const install = spawnSync("brew", ["install", "node"], { stdio: "inherit" });
        return install.status === 0;
      }
      return false;
    }
    case "linux": {
      // Try nvm only. Distro package managers require sudo and vary too much
      // to safely automate. Fall back to guidance on failure.
      const hasNvm = spawnSync("bash", ["-lc", "command -v nvm"], { encoding: "utf8" });
      if (hasNvm.status === 0 && hasNvm.stdout.trim()) {
        const install = spawnSync("bash", ["-lc", "nvm install --lts"], { stdio: "inherit" });
        return install.status === 0;
      }
      return false;
    }
    case "win32": {
      const install = spawnSync("winget", ["install", "OpenJS.NodeJS"], { stdio: "inherit" });
      return install.status === 0;
    }
    default:
      return false;
  }
}

/**
 * The function every other script in the bundle calls first.
 * Exits the process on unrecoverable failure.
 * @param {object} options
 * @param {boolean} [options.autoInstall] if true, attempt a supported install
 */
export async function preflight(options = {}) {
  const state = detectNode();
  if (state.ok) return state;

  const header = `node ${state.current} detected; this bundle requires Node ${state.required} or newer.`;
  process.stderr.write(`\n${header}\n\n`);

  if (options.autoInstall) {
    process.stderr.write(`Attempting auto-install on ${state.platform}...\n`);
    const ok = autoInstall(state.platform);
    if (ok) {
      process.stderr.write(
        `Installation finished. Re-run the command; the new Node must be on PATH.\n`
      );
      process.exit(2);
    }
    process.stderr.write(`Auto-install failed.\n\n`);
  }

  process.stderr.write(installGuidance(state.platform) + "\n\n");
  process.exit(1);
}

/** When this file is executed directly, print the preflight report. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const state = detectNode();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(state, null, 2));
  if (!state.ok) {
    console.error("\n" + installGuidance(state.platform));
    process.exit(1);
  }
}
