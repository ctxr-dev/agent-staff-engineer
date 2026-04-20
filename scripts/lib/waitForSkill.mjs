// lib/waitForSkill.mjs
// Interactive dependency-wait helper used by install.mjs when a
// required companion skill is missing and the user is sitting at a
// real terminal. The wait loop prompts the user, polls for the skill,
// and accepts Enter (re-check), `help` (print a troubleshooting
// blurb), and `abort` (exit cleanly). Any other input, including
// arbitrary typed text, is treated the same as Enter: the helper
// re-probes for the skill and continues waiting. This deliberately
// keeps the happy path forgiving — a user who accidentally hit a
// key before Enter doesn't get a special error.
//
// Factored out of install.mjs so the logic is unit-testable without
// having to run the install body. Every external effect (streams,
// process.exit, SIGINT handling, the locator function) is injectable
// via the options object; defaults match production behaviour.
//
// The caller owns the decision of whether to enter the wait at all;
// this module does not inspect TTY state. install.mjs gates the call
// behind two isTTY checks (stdin + stdout), !YES, and a `runningInCi`
// predicate that treats both `CI=""` and `CI="false"` as "not CI" (so
// a locally-unset or explicitly-disabled CI env var doesn't force the
// CI branch). Together these stop pseudo-TTYs in CI environments
// (GitHub Actions with `tty: true`, Buildkite, etc.) from triggering
// a prompt the runner can't answer.

import { createInterface } from "node:readline/promises";
import { MIN_NODE_MAJOR } from "../preflight.mjs";

/**
 * Signalled by the wait loop when the user types `abort`. The helper
 * calls `exit(1)` first; if `exit` terminates the process (the
 * production default), this error is never observed. If `exit` is a
 * test stub that returns, throwing this error instead of returning
 * `null` keeps the function's Promise<string> contract intact so
 * downstream callers can't mistake a "user aborted" result for a
 * real install path.
 */
export class InstallAbortedByUserError extends Error {
  constructor(message = "Install aborted by user") {
    super(message);
    this.name = "InstallAbortedByUserError";
  }
}

/**
 * Block until `locate(provider, target)` returns a truthy path, the
 * user aborts, or SIGINT is received.
 *
 * Non-interactive callers (CI / piped stdin / --yes installs) should
 * NOT call this function; they should emit a fail-fast error
 * themselves. `waitForRequiredSkill` assumes it is running in an
 * environment where a prompt makes sense.
 *
 * @param {object} opts
 * @param {string} opts.provider        Skill package name, e.g. "@ctxr/skill-llm-wiki".
 * @param {string} opts.target          Target project root (used by locate()).
 * @param {string[]} opts.candidates    Human-readable list of paths to print in the prompt.
 * @param {(provider: string, target: string) => string|null|undefined} opts.locate
 *                                      Probe that returns an absolute path (truthy) when
 *                                      the skill is installed, or a falsy value when missing.
 * @param {string} [opts.rerunCommand]  Pre-shell-quoted command the user should run after
 *                                      aborting. install.mjs builds this with its existing
 *                                      shellQuote/psQuote helpers (platform-aware) so paths
 *                                      with spaces / metacharacters survive copy-paste.
 *                                      When omitted, falls back to a naive argv join.
 * @param {NodeJS.ReadableStream} [opts.stdin=process.stdin]   Input stream for the prompt.
 * @param {NodeJS.WritableStream} [opts.stdout=process.stdout] Where prompts + help go.
 * @param {NodeJS.WritableStream} [opts.stderr=process.stderr] Where abort / SIGINT messages go.
 * @param {(code: number) => void} [opts.exit=process.exit]    Process-exit function.
 *                                      Real process.exit() never returns, but the helper
 *                                      is also callable with a non-terminating stub (tests
 *                                      pass one that returns); abort then throws
 *                                      InstallAbortedByUserError so the Promise<string>
 *                                      contract holds. Type is `void` rather than `never`
 *                                      so editor inference doesn't flag the post-exit line.
 * @param {(sig: string, handler: () => void) => void} [opts.on=process.on.bind(process)]
 *                                      Signal registrar (injected for tests).
 * @param {(sig: string, handler: () => void) => void} [opts.off=process.off.bind(process)]
 *                                      Signal deregistrar (injected for tests).
 * @param {() => import("node:readline/promises").Interface} [opts.makeReadline]
 *                                      Factory for the readline interface (injected for tests).
 *                                      Must return an object whose `question(prompt)` returns a
 *                                      Promise<string> and whose `close()` aborts that pending
 *                                      promise; the helper uses `node:readline/promises`, not the
 *                                      callback-based `node:readline` surface.
 *
 * @returns {Promise<string>} the absolute path returned by `locate()` when the skill appears.
 *                            Throws InstallAbortedByUserError on abort when `exit` is a
 *                            non-terminating stub (tests); in production, `exit` ends the
 *                            process before the throw is observed.
 */
export async function waitForRequiredSkill({
  provider,
  target,
  candidates,
  locate,
  rerunCommand,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
  on = (sig, h) => process.on(sig, h),
  off = (sig, h) => process.off(sig, h),
  makeReadline,
}) {
  let found = locate(provider, target);
  if (found) return found;

  stdout.write(
    `\nThe agent needs a companion skill that isn't installed yet.\n` +
    `  Missing: ${provider}\n` +
    `  I searched:\n    ${candidates.join("\n    ")}\n\n` +
    `To install it, run this in a separate terminal:\n` +
    `  npx @ctxr/kit install ${provider}\n\n` +
    `I'll wait here until it's ready.\n`,
  );

  const rl = makeReadline
    ? makeReadline()
    : createInterface({ input: stdin, output: stdout });

  // Handle Ctrl+C while rl.question() is waiting. The readline interface
  // must be closed BEFORE exit so the pending question is aborted and the
  // terminal is restored to cooked mode; otherwise the shell inherits a
  // half-raw terminal. Exit 130 is the POSIX convention for "terminated
  // by SIGINT".
  //
  // If `exit` returns (test stub; hypothetical future reuse where the
  // caller wants to keep the process alive), we stash the SIGINT error
  // and re-throw from the pending rl.question() so the async wait loop
  // rejects and the shared `finally` cleanup still runs deterministically.
  // Without this, a SIGINT with a non-terminating exit would leave the
  // Promise hanging forever.
  let sigintError = null;
  const onSigint = () => {
    stderr.write("\ninstall: interrupted\n");
    sigintError = new Error("Install interrupted by SIGINT");
    rl.close();
    exit(130);
  };
  on("SIGINT", onSigint);

  try {
    for (;;) {
      let raw;
      try {
        raw = await rl.question(
          `\nWhen '${provider}' is installed, press Enter to continue. ` +
          `Type 'help' for troubleshooting, or 'abort' to cancel: `,
        );
      } catch (err) {
        // rl.question() rejects when rl.close() runs mid-flight, which
        // is what happens on SIGINT. Surface the SIGINT error if we
        // have one; otherwise rethrow whatever the readline layer gave
        // us (unexpected, but don't swallow).
        if (sigintError) throw sigintError;
        throw err;
      }
      if (sigintError) throw sigintError;
      const answer = String(raw ?? "").trim().toLowerCase();

      if (answer === "abort") {
        // The caller (install.mjs) typically passes a pre-shell-quoted
        // rerunCommand so paths with spaces survive copy-paste. If no
        // pre-formatted command is supplied, fall back to a naive
        // argv join; it works for the common case but breaks on
        // whitespace-containing arguments.
        const argv = Array.isArray(process.argv) ? process.argv : [];
        const rerun = rerunCommand
          ?? (argv.length >= 2
            ? `${argv[0]} ${argv.slice(1).join(" ")}`
            : "<re-run with the same flags you used>");
        stderr.write(
          `\nInstall aborted at your request. Re-run when the skill is ready:\n` +
          `  ${rerun}\n`,
        );
        // Close readline and remove the SIGINT handler BEFORE exit so
        // the terminal is restored from raw mode even when `exit` is
        // real process.exit() (which skips the outer `finally`).
        // rl.close() and off() are both idempotent, so the finally
        // block's redundant call is harmless on the test-stub path.
        rl.close();
        off("SIGINT", onSigint);
        exit(1);
        // If `exit` returned (test stub), throw so the function honors
        // its Promise<string> contract and callers never see a null
        // masquerading as a real install path. The idempotent cleanup
        // above means the finally block's second call is a no-op.
        throw new InstallAbortedByUserError();
      }

      if (answer === "help") {
        // The "manual clone" tip is only useful for the default
        // provider because its git URL is stable. Configurable
        // providers could live anywhere; printing a hardcoded URL
        // would mislead the user. Show the manual tip only when the
        // provider matches the default; otherwise point at its own
        // source repo by name so the user knows what to look up.
        const DEFAULT_PROVIDER = "@ctxr/skill-llm-wiki";
        const manualHint = provider === DEFAULT_PROVIDER
          ? `  6. If kit itself is misbehaving, you can alternatively clone the skill manually:\n` +
            `       git clone https://github.com/ctxr-dev/skill-llm-wiki.git \\\n` +
            `         ~/.claude/skills/ctxr-skill-llm-wiki\n` +
            `     and re-run this installer.\n\n`
          : `  6. If kit itself is misbehaving, consult the README for '${provider}' (usually\n` +
            `     a git clone into ~/.claude/skills/) and re-run this installer.\n\n`;
        stdout.write(
          `\nTroubleshooting tips for 'npx @ctxr/kit install ${provider}':\n` +
          `  1. 'npx: command not found' -> install Node.js + npm from nodejs.org. The agent needs\n` +
          `     Node ${MIN_NODE_MAJOR} or newer.\n` +
          `  2. 'Not found in registry' -> double-check the package name: '${provider}'. A typo is the\n` +
          `     most common cause.\n` +
          `  3. Permission / EACCES errors -> retry the install with a different destination; kit's\n` +
          `     interactive menu lets you pick ~/.claude/ (user-local) which avoids sudo.\n` +
          `  4. Behind a corporate proxy -> configure npm's proxy settings first\n` +
          `     ('npm config set proxy ...' and 'npm config set https-proxy ...') and re-run.\n` +
          `  5. Already installed somewhere unusual? I check these locations (in order):\n` +
          `       ${candidates.join("\n       ")}\n` +
          `     If your skill landed elsewhere, reinstall via kit so it goes to one of these.\n` +
          manualHint +
          `If you still get an error, copy the full message and paste it into Claude, ChatGPT, or your\n` +
          `preferred support channel for help troubleshooting.\n`,
        );
        continue;
      }

      // Any other input (including empty Enter) means "check again".
      found = locate(provider, target);
      if (found) return found;

      stdout.write(
        `\nStill not finding '${provider}' at any known location.\n` +
        `  Checked: ${candidates.join(", ")}\n` +
        `  - Confirm the install command finished without errors.\n` +
        `  - If it completed in another terminal, double-check the scope (@ctxr) and package name.\n` +
        `Type 'help' for more guidance, or press Enter to check again.\n`,
      );
    }
  } finally {
    rl.close();
    off("SIGINT", onSigint);
  }
}
