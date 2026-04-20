// waitForSkill.test.mjs
// Unit tests for the extracted interactive-wait helper used by
// install.mjs when a required companion skill is missing. The helper
// is injectable (streams, exit, signal handlers, readline factory),
// so these tests don't need a real TTY or child process.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForRequiredSkill } from "../scripts/lib/waitForSkill.mjs";

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

/** Collect calls to process.exit into an array instead of actually exiting. */
function makeExitStub() {
  const calls = [];
  return {
    exit: (code) => {
      calls.push(code);
      // Throw so the wait loop unwinds (mirrors process.exit's effect).
      const err = new Error(`exit(${code})`);
      err.__exitCode = code;
      throw err;
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
});

describe("waitForRequiredSkill: abort command", () => {
  it("calls exit(1), prints a rerun command derived from process.argv, and does not loop", async () => {
    const stdout = makeWriteStub();
    const stderr = makeWriteStub();
    const exitStub = makeExitStub();
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
      /exit\(1\)/,
    );
    assert.deepEqual(exitStub.calls, [1], "exit(1) must be called exactly once on abort");
    assert.match(stderr.text(), /Install aborted at your request/);
    assert.match(stderr.text(), /Re-run when the skill is ready/);
    // The rerun line should include the actual process.argv[0] (node) —
    // we don't assert the specific path because it varies per host.
    assert.ok(stderr.text().includes(process.argv[0]), "rerun command should echo process.argv[0]");
    assert.equal(offCalled, true, "SIGINT handler must be removed on abort");
  });
});

describe("waitForRequiredSkill: SIGINT handler wiring", () => {
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
