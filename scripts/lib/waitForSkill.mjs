// lib/waitForSkill.mjs
// Interactive dependency-wait helper used by install.mjs when a
// required companion skill is missing and the user is sitting at a
// real terminal. The wait loop prompts the user, polls for the skill,
// and accepts three inputs: Enter (re-check), `help` (print a
// troubleshooting blurb), `abort` (exit cleanly).
//
// Factored out of install.mjs so the logic is unit-testable without
// having to run the install body. Every external effect (streams,
// process.exit, SIGINT handling, the locator function) is injectable
// via the options object; defaults match production behaviour.
//
// The caller owns the decision of whether to enter the wait at all;
// this module does not inspect TTY state. install.mjs gates the call
// behind `processStdin.isTTY && processStdout.isTTY && !YES`.

import { createInterface } from "node:readline/promises";

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
 * @param {NodeJS.ReadableStream} [opts.stdin=process.stdin]   Input stream for the prompt.
 * @param {NodeJS.WritableStream} [opts.stdout=process.stdout] Where prompts + help go.
 * @param {NodeJS.WritableStream} [opts.stderr=process.stderr] Where abort / SIGINT messages go.
 * @param {(code: number) => never} [opts.exit=process.exit]   Process-exit function.
 * @param {(sig: string, handler: () => void) => void} [opts.on=process.on.bind(process)]
 *                                      Signal registrar (injected for tests).
 * @param {(sig: string, handler: () => void) => void} [opts.off=process.off.bind(process)]
 *                                      Signal deregistrar (injected for tests).
 * @param {() => readline.Interface} [opts.makeReadline]
 *                                      Factory for the readline interface (injected for tests).
 *
 * @returns {Promise<string>} the absolute path returned by `locate()` when the skill appears.
 */
export async function waitForRequiredSkill({
  provider,
  target,
  candidates,
  locate,
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

  // Handle Ctrl+C while rl.question() is waiting. Without this, a
  // SIGINT would leave the readline interface open and potentially
  // corrupt the terminal state. Exit 130 is the POSIX convention for
  // "terminated by SIGINT".
  const onSigint = () => {
    rl.close();
    stderr.write("\ninstall: interrupted\n");
    exit(130);
  };
  on("SIGINT", onSigint);

  try {
    for (;;) {
      const raw = await rl.question(
        `\nWhen '${provider}' is installed, press Enter to continue. ` +
        `Type 'help' for troubleshooting, or 'abort' to cancel: `,
      );
      const answer = String(raw ?? "").trim().toLowerCase();

      if (answer === "abort") {
        // Derive the re-run command from the actual invocation so the
        // user can copy it verbatim. Avoids hardcoding `--apply` when
        // the user was running `--update` or some other mode.
        const argv = Array.isArray(process.argv) ? process.argv : [];
        const rerun = argv.length >= 2
          ? `${argv[0]} ${argv.slice(1).join(" ")}`
          : "<re-run with the same flags you used>";
        stderr.write(
          `\nInstall aborted at your request. Re-run when the skill is ready:\n` +
          `  ${rerun}\n`,
        );
        rl.close();
        off("SIGINT", onSigint);
        exit(1);
        // `exit` may be a test stub that returns instead of throwing.
        // Fall through so the function still returns in that case.
        return null;
      }

      if (answer === "help") {
        stdout.write(
          `\nTroubleshooting tips for 'npx @ctxr/kit install ${provider}':\n` +
          `  1. 'npx: command not found' -> install Node.js + npm from nodejs.org. The agent needs\n` +
          `     Node 20 or newer.\n` +
          `  2. 'Not found in registry' -> double-check the package name: '${provider}'. A typo is the\n` +
          `     most common cause.\n` +
          `  3. Permission / EACCES errors -> retry the install with a different destination; kit's\n` +
          `     interactive menu lets you pick ~/.claude/ (user-local) which avoids sudo.\n` +
          `  4. Behind a corporate proxy -> configure npm's proxy settings first\n` +
          `     ('npm config set proxy ...' and 'npm config set https-proxy ...') and re-run.\n` +
          `  5. Already installed somewhere unusual? I check these locations (in order):\n` +
          `       ${candidates.join("\n       ")}\n` +
          `     If your skill landed elsewhere, reinstall via kit so it goes to one of these.\n` +
          `  6. If kit itself is misbehaving, you can alternatively clone the skill manually:\n` +
          `       git clone https://github.com/ctxr-dev/skill-llm-wiki.git \\\n` +
          `         ~/.claude/skills/ctxr-skill-llm-wiki\n` +
          `     and re-run this installer.\n\n` +
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
