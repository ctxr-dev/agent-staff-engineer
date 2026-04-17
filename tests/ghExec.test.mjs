import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghExec } from "../scripts/lib/ghExec.mjs";

// Build a fake `gh` on PATH for isolated tests. On Windows we skip this —
// shimming a PATH entry is fiddly and the production code already passes
// shell:true there, so the real `gh.exe` resolution path is exercised by
// the CI matrix.
const IS_WIN = process.platform === "win32";

async function installFakeGh(behavior) {
  const scratch = await mkdtemp(join(tmpdir(), "fake-gh-"));
  const scriptPath = join(scratch, "gh");
  await writeFile(scriptPath, behavior, "utf8");
  await chmod(scriptPath, 0o755);
  return { scratch, scriptPath };
}

describe("ghExec", { skip: IS_WIN ? "windows path shim requires .cmd; covered in CI matrix" : false }, () => {
  it("returns a non-zero code when gh is absent", async () => {
    const pathBefore = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-dir";
      await assert.rejects(() => ghExec(["api", "user"], { timeoutMs: 1000 }), /gh not executable/);
    } finally {
      process.env.PATH = pathBefore;
    }
  });

  it("captures stdout on success via a shimmed gh", async () => {
    const { scratch, scriptPath } = await installFakeGh(`#!/bin/sh\nprintf '{"login":"nobody"}'\n`);
    const pathBefore = process.env.PATH;
    try {
      process.env.PATH = scratch + ":" + pathBefore;
      const res = await ghExec(["api", "user"], { format: "json", timeoutMs: 2000 });
      assert.equal(res.code, 0);
      assert.deepEqual(res.json, { login: "nobody" });
    } finally {
      process.env.PATH = pathBefore;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects on timeout and escalates to SIGKILL", async () => {
    const { scratch } = await installFakeGh(`#!/bin/sh\ntrap '' TERM\nsleep 10\n`);
    const pathBefore = process.env.PATH;
    try {
      process.env.PATH = scratch + ":" + pathBefore;
      const start = Date.now();
      await assert.rejects(
        () => ghExec(["api", "user"], { timeoutMs: 200 }),
        /timed out/
      );
      const elapsed = Date.now() - start;
      // SIGTERM + 2 s grace + SIGKILL should finish in a handful of seconds.
      assert.ok(elapsed < 5000, `timeout path took ${elapsed}ms, expected < 5000`);
    } finally {
      process.env.PATH = pathBefore;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("records jsonError instead of throwing when stdout is not JSON", async () => {
    const { scratch } = await installFakeGh(`#!/bin/sh\nprintf 'not json'\n`);
    const pathBefore = process.env.PATH;
    try {
      process.env.PATH = scratch + ":" + pathBefore;
      const res = await ghExec(["api", "user"], { format: "json", timeoutMs: 2000 });
      assert.equal(res.code, 0);
      assert.equal(res.json, undefined);
      assert.ok(typeof res.jsonError === "string" && res.jsonError.length > 0);
    } finally {
      process.env.PATH = pathBefore;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
