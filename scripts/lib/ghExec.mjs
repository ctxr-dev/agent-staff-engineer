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

/**
 * Thrown by ghGraphqlQuery / ghGraphqlMutation when the API reports one or
 * more errors, or when the response cannot be parsed. Carries the original
 * `errors[]` payload (when present) and the query text so callers can log a
 * useful diagnostic without re-running the mutation.
 */
export class GhGraphqlError extends Error {
  constructor(message, { errors = null, query = null } = {}) {
    super(message);
    this.name = "GhGraphqlError";
    this.errors = errors;
    this.query = query;
  }
}

/**
 * Run a GitHub GraphQL query. Variables with scalar values (strings,
 * numbers, booleans) are passed via `gh api graphql -F <name>=<value>` —
 * the same mechanism the runbook uses. For array/object args, inline the
 * values into the query string at the caller site (this is how GitHub
 * GraphQL features like `botIds: [...]` are typically invoked).
 *
 * Returns the `data` root on success. Throws {@link GhGraphqlError} on
 * either a non-zero gh exit, an unparseable response, a response without
 * `data`, or a response with a non-empty `errors[]`.
 *
 * @param {string} query             GraphQL query text
 * @param {Record<string, string|number|boolean>} [vars]
 * @param {{ timeoutMs?: number, cwd?: string }} [options]
 * @returns {Promise<any>} the `data` root
 */
export async function ghGraphqlQuery(query, vars = {}, options = {}) {
  return ghGraphqlExec(query, vars, options);
}

/**
 * Same shape as {@link ghGraphqlQuery}; named separately so that callers'
 * intent is visible at call sites. GitHub Actions / API responses do not
 * distinguish queries from mutations at the transport layer.
 */
export async function ghGraphqlMutation(mutation, vars = {}, options = {}) {
  return ghGraphqlExec(mutation, vars, options);
}

async function ghGraphqlExec(queryText, vars, options) {
  if (typeof queryText !== "string" || queryText.length === 0) {
    throw new TypeError("ghGraphql*: query must be a non-empty string");
  }
  const args = ["api", "graphql", "-f", `query=${queryText}`];
  for (const [k, v] of Object.entries(vars || {})) {
    if (v == null) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new TypeError(
        `ghGraphql*: variable '${k}' must be a string, number, or boolean (got ${typeof v}); inline complex types into the query string instead`,
      );
    }
    // `-F` makes gh type booleans and numbers; strings stay strings.
    args.push("-F", `${k}=${v}`);
  }
  const res = await ghExec(args, {
    format: "json",
    timeoutMs: options.timeoutMs ?? 30_000,
    cwd: options.cwd,
  });
  if (res.code !== 0) {
    throw new GhGraphqlError(
      `gh api graphql exited ${res.code}: ${(res.stderr || res.stdout).trim()}`,
      { query: queryText },
    );
  }
  if (!res.json) {
    throw new GhGraphqlError(
      `gh api graphql returned unparseable JSON${res.jsonError ? ` (${res.jsonError})` : ""}`,
      { query: queryText },
    );
  }
  if (Array.isArray(res.json.errors) && res.json.errors.length > 0) {
    const msg = res.json.errors
      .map((e) => e.message || JSON.stringify(e))
      .join("; ");
    throw new GhGraphqlError(msg, {
      errors: res.json.errors,
      query: queryText,
    });
  }
  if (res.json.data == null) {
    throw new GhGraphqlError(
      "gh api graphql returned no data field",
      { query: queryText },
    );
  }
  return res.json.data;
}
