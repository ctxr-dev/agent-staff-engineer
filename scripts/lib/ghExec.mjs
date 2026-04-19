// lib/ghExec.mjs
// Thin wrapper around `gh` (GitHub CLI). Captures stdout, stderr, and exit code.
// Zero npm deps. Uses spawn so we can safely pass argv arrays without shell quoting
// on POSIX. On Windows, Node's `spawn` requires the explicit `.exe`/`.cmd` extension
// or `shell: true`; we pass `shell: true` on win32 since the argv we construct is
// made of static identifiers and user-supplied values have already been validated
// by bootstrap's schema pattern (no shell-metacharacters permitted in owner/repo).

import { spawn } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Run a `gh` command.
 * @param {string[]} args  e.g. ["api", "/repos/OWNER/REPO/labels"]
 * @param {object} options
 * @param {string} [options.cwd]     working directory for the child process
 * @param {number} [options.timeoutMs] kill the process after N ms (default 30000)
 * @param {"text"|"json"} [options.format] if "json", parse stdout as JSON
 * @returns {Promise<{ stdout: string, stderr: string, code: number, json?: any }>}
 */
export function ghExec(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WINDOWS,
    });
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let killHardTimer = null;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (killHardTimer) clearTimeout(killHardTimer);
      fn();
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // SIGKILL escalation after a grace period if SIGTERM is ignored.
      killHardTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        settle(() =>
          reject(new Error(`gh ${args.join(" ")} timed out after ${timeoutMs}ms (SIGKILL)`))
        );
      }, 2000);
    }, timeoutMs);

    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));

    child.on("error", (e) => {
      settle(() =>
        reject(
          new Error(
            `gh not executable on PATH (${process.env.PATH ?? "<empty>"}): ${e.message}. Install with 'brew install gh' or see https://cli.github.com/manual/installation`
          )
        )
      );
    });

    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`gh ${args.join(" ")} timed out after ${timeoutMs}ms`));
          return;
        }
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        const result = { stdout, stderr, code: code ?? -1 };
        if (options.format === "json" && stdout.trim().length > 0) {
          try {
            result.json = JSON.parse(stdout);
          } catch (e) {
            result.jsonError = e.message;
          }
        }
        resolve(result);
      });
    });
  });
}

/** Run `gh auth status` and report whether the user is logged in. */
export async function ghAuthReady() {
  const res = await ghExec(["auth", "status"], { timeoutMs: 5000 });
  return res.code === 0;
}

/** Run `gh api user` and return the JSON user record, or null on any failure. */
export async function ghCurrentUser() {
  const res = await ghExec(["api", "user"], { format: "json", timeoutMs: 10_000 });
  if (res.code !== 0) return null;
  return res.json ?? null;
}
