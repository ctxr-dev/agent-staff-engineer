// waitForSkill.test.mjs
// Unit tests for the extracted interactive-wait helper used by
// install.mjs when a required companion skill is missing. The helper
// is injectable (streams, exit, signal handlers, readline factory),
// so these tests don't need a real TTY or child process.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForRequiredSkill, InstallAbortedByUserError } from "../scripts/lib/waitForSkill.mjs";

/**
 * Minimal writable-stream stub. Captures every write into an array
 * so tests can assert on the rendered output without parsing a real
 * Buffer. We only need .write() in the helper's code path.
 */
function makeWriteStub() {
  const writes = [];
  return {
    write: (chunk) => {
      writes.push(String(chunk));
      return true;
    },
    text: () => writes.join(""),
  };
}

/**
 * Minimal readline stub. Scripts a queue of answers that rl.question()
 * yields one at a time; rl.close() is a no-op. Tests assert on the
 * helper's end-state via the streams + the locate probe, not on
 * readline internals.
 */
function makeReadlineStub(answers) {
  const queue = [...answers];
  return {
    question: async (_prompt) => {
      if (queue.length === 0) {
        throw new Error("readline stub: exhausted; did the wait loop hit more prompts than scripted?");
      }
      return queue.shift();
    },
    close: () => {},
  };
}

/**
 * Collect calls to process.exit into an array. By default the stub
 * RETURNS instead of throwing, which is the scenario the helper's
 * abort branch is designed to handle (so it falls through and throws
 * InstallAbortedByUserError to honor its Promise<string> contract).
 * Pass `{ throwOnExit: true }` for the alternate shape where exit
 * synchronously aborts execution like the real process.exit.
 */
function makeExitStub({ throwOnExit = false } = {}) {
  const calls = [];
  return {
    exit: (code) => {
      calls.push(code);
      if (throwOnExit) {
        const err = new Error(`exit(${code})`);
        err.__exitCode = code;
        throw err;
      }
    },
    calls,
  };
}

describe("waitForRequiredSkill: fast path", () => {
  it("returns immediately when the skill is already installed", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();
    const found = await waitForRequiredSkill({
      provider: "@ctxr/skill-llm-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
      locate: () => "/absolute/path/to/installed/skill",
      stdout,
      stderr,
      exit: exitStub.exit,
      on: () => {},
      off: () => {},
      makeReadline: () => {
        throw new Error("makeReadline must not be called when the skill is already present");
      },
    });
    assert.equal(found, "/absolute/path/to/installed/skill");
    assert.equal(stdout.text(), "", "no prompt should be printed when the skill is already there");
    assert.equal(exitStub.calls.length, 0, "exit should not be called on the fast path");
  });
});

describe("waitForRequiredSkill: interactive happy path", () => {
  it("returns the located path after the user installs the skill and presses Enter", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();

    // locate() returns null on the first two calls (initial check +
    // first Enter), then the absolute path on the third (second
    // Enter, after user installed it). The scripted answers drive
    // the loop to exactly those three probes.
    let probe = 0;
    const locate = () => {
      probe += 1;
      if (probe >= 3) return "/usr/local/skill/here";
      return null;
    };

    const found = await waitForRequiredSkill({
      provider: "@ctxr/skill-llm-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
      locate,
      stdout,
      stderr,
      exit: exitStub.exit,
      on: () => {},
      off: () => {},
      // The first Enter sees "still not found", prints retry help; the
      // second Enter triggers the probe that returns the path.
      makeReadline: () => makeReadlineStub(["", ""]),
    });
    assert.equal(found, "/usr/local/skill/here");
    assert.match(stdout.text(), /isn't installed yet/, "initial prompt must appear");
    assert.match(stdout.text(), /Still not finding/, "retry message must appear on miss");
  });
});

describe("waitForRequiredSkill: help command", () => {
  it("prints troubleshooting blurb and continues waiting", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();

    // Call count sequence with 3 prompts ["help", "", ""]:
    //   1) initial locate() at function entry      -> null (probe=1)
    //   2) prompt "help" -> continue (no locate)
    //   3) prompt ""     -> locate()               -> null (probe=2), print retry
    //   4) prompt ""     -> locate()               -> "/found" (probe=3), return
    let probe = 0;
    const locate = () => {
      probe += 1;
      if (probe >= 3) return "/found";
      return null;
    };

    const found = await waitForRequiredSkill({
      provider: "@ctxr/skill-llm-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
      locate,
      stdout,
      stderr,
      exit: exitStub.exit,
      on: () => {},
      off: () => {},
      makeReadline: () => makeReadlineStub(["help", "", ""]),
    });
    assert.equal(found, "/found");
    assert.match(stdout.text(), /Troubleshooting tips/, "help blurb must appear");
    assert.match(stdout.text(), /proxy/, "help text must mention the proxy troubleshooting line");
    assert.match(stdout.text(), /copy the full message and paste it into/, "tool-neutral paste-into-assistant guidance must appear");
  });

  // Round-8 T1: the manual git-clone URL is only correct for the
  // default provider. For custom providers we must not hardcode a
  // URL that might not exist; instead we tell the user to consult
  // that provider's README.
  it("hides the default-provider git URL when a custom provider is configured", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();

    let probe = 0;
    const locate = () => {
      probe += 1;
      return probe >= 3 ? "/found" : null;
    };

    await waitForRequiredSkill({
      provider: "@example/some-other-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/example-some-other-wiki"],
      locate,
      stdout,
      stderr,
      exit: exitStub.exit,
      on: () => {},
      off: () => {},
      makeReadline: () => makeReadlineStub(["help", "", ""]),
    });
    const out = stdout.text();
    assert.doesNotMatch(
      out,
      /github\.com\/ctxr-dev\/skill-llm-wiki/,
      "custom providers must not surface the default provider's git URL",
    );
    assert.match(
      out,
      /consult the README for '@example\/some-other-wiki'/,
      "custom providers get a README-pointer tip instead",
    );
  });

  it("shows the default-provider git URL when provider matches the default", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();

    let probe = 0;
    const locate = () => {
      probe += 1;
      return probe >= 3 ? "/found" : null;
    };

    await waitForRequiredSkill({
      provider: "@ctxr/skill-llm-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
      locate,
      stdout,
      stderr,
      exit: exitStub.exit,
      on: () => {},
      off: () => {},
      makeReadline: () => makeReadlineStub(["help", "", ""]),
    });
    assert.match(
      stdout.text(),
      /git clone https:\/\/github\.com\/ctxr-dev\/skill-llm-wiki\.git/,
      "default provider should keep its concrete clone URL",
    );
  });
});

describe("waitForRequiredSkill: abort command", () => {
  it("calls exit(1) and throws InstallAbortedByUserError when exit is a non-terminating stub", async () => {
    // Models the test-harness case where `exit` returns instead of
    // aborting the process. The helper must still honor its
    // Promise<string> contract, so it throws after exit returns.
    // In production, `process.exit` terminates before the throw is
    // observed, so real users never see the error.
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub(); // returns, does not throw
    let offCalled = false;

    await assert.rejects(
      () => waitForRequiredSkill({
        provider: "@ctxr/skill-llm-wiki",
        target: "/tmp/test",
        candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
        locate: () => null,
        stdout,
        stderr,
        exit: exitStub.exit,
        on: () => {},
        off: () => { offCalled = true; },
        makeReadline: () => makeReadlineStub(["abort"]),
      }),
      (err) => err instanceof InstallAbortedByUserError,
    );
    assert.deepEqual(exitStub.calls, [1], "exit(1) must be called exactly once on abort");
    assert.match(stderr.text(), /Install aborted at your request/);
    assert.match(stderr.text(), /Re-run when the skill is ready/);
    assert.equal(offCalled, true, "SIGINT handler must be removed on abort (via finally)");
  });

  it("uses the injected rerunCommand verbatim in the stderr hint", async () => {
    // Round-4 T2: paths with spaces break a naive argv join. The
    // caller (install.mjs) shell-quotes the command and injects it;
    // the helper must print it verbatim without re-quoting.
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();

    await assert.rejects(
      () => waitForRequiredSkill({
        provider: "@ctxr/skill-llm-wiki",
        target: "/tmp/test",
        candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
        locate: () => null,
        rerunCommand: "node '/pre/quoted/path with spaces/install.mjs' --apply",
        stdout,
        stderr,
        exit: exitStub.exit,
        on: () => {},
        off: () => {},
        makeReadline: () => makeReadlineStub(["abort"]),
      }),
      InstallAbortedByUserError,
    );
    assert.match(
      stderr.text(),
      /node '\/pre\/quoted\/path with spaces\/install\.mjs' --apply/,
      "injected rerunCommand must be printed verbatim",
    );
  });

  it("falls back to a naive argv join when no rerunCommand is injected", async () => {
    // Regression guard: the old behavior (before the injection
    // parameter existed) was to derive the rerun from process.argv
    // inline. Preserve it as a fallback so callers that omit
    // rerunCommand still get something on the prompt.
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();

    await assert.rejects(
      () => waitForRequiredSkill({
        provider: "@ctxr/skill-llm-wiki",
        target: "/tmp/test",
        candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
        locate: () => null,
        // no rerunCommand
        stdout,
        stderr,
        exit: exitStub.exit,
        on: () => {},
        off: () => {},
        makeReadline: () => makeReadlineStub(["abort"]),
      }),
      InstallAbortedByUserError,
    );
    assert.ok(
      stderr.text().includes(process.argv[0]),
      "fallback rerun must echo process.argv[0] at minimum",
    );
  });
});

describe("waitForRequiredSkill: SIGINT handling", () => {
  it("closes readline, writes 'interrupted' to stderr, and rejects the wait Promise when SIGINT fires", async () => {
    // Round-6 T1: without this, a SIGINT with a non-terminating exit
    // stub would leave rl.question() pending forever (and, in
    // production, leave the terminal in a half-raw state). The handler
    // must close rl first AND the wait loop must throw so the Promise
    // rejects and `finally` runs.
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();
    let capturedHandler = null;
    const offCalls = [];

    // Custom readline stub whose `question()` rejects when close() is
    // called mid-flight (mirrors the real readline behavior). We
    // kick SIGINT asynchronously after the question starts waiting.
    function makeSigintRl() {
      let rejectQ;
      const rl = {
        question: () => new Promise((_, reject) => { rejectQ = reject; }),
        close: () => {
          if (rejectQ) rejectQ(new Error("readline closed"));
        },
      };
      return rl;
    }

    const waitPromise = waitForRequiredSkill({
      provider: "@ctxr/skill-llm-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
      locate: () => null,
      stdout,
      stderr,
      exit: exitStub.exit,
      on: (sig, h) => { if (sig === "SIGINT") capturedHandler = h; },
      off: (sig, h) => offCalls.push({ sig, h }),
      makeReadline: makeSigintRl,
    });

    // Fire SIGINT on the next tick, after the wait loop has called
    // rl.question() and is awaiting.
    setImmediate(() => {
      assert.ok(capturedHandler, "SIGINT handler must be registered before SIGINT fires");
      capturedHandler();
    });

    await assert.rejects(
      () => waitPromise,
      (err) => err instanceof Error && /SIGINT/.test(err.message),
    );
    assert.match(stderr.text(), /install: interrupted/);
    assert.deepEqual(exitStub.calls, [130], "SIGINT must call exit(130)");
    assert.equal(offCalls.length, 1, "SIGINT handler must be removed once (via finally)");
    assert.equal(offCalls[0].sig, "SIGINT");
  });

  it("registers a SIGINT handler while waiting and removes it on normal exit", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();
    const registered = [];
    const removed = [];

    let probe = 0;
    const locate = () => {
      probe += 1;
      if (probe >= 2) return "/found";
      return null;
    };

    await waitForRequiredSkill({
      provider: "@ctxr/skill-llm-wiki",
      target: "/tmp/test",
      candidates: ["~/.claude/skills/ctxr-skill-llm-wiki"],
      locate,
      stdout,
      stderr,
      exit: exitStub.exit,
      on: (sig, h) => registered.push({ sig, h }),
      off: (sig, h) => removed.push({ sig, h }),
      makeReadline: () => makeReadlineStub([""]),
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].sig, "SIGINT");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].sig, "SIGINT");
    assert.strictEqual(removed[0].h, registered[0].h, "the same handler must be removed that was registered");
  });
});
