import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePrefix, prefixed, getAgentPrefix, PREFIX_SEPARATOR } from "../scripts/lib/agentName.mjs";

const scratch = await mkdtemp(join(tmpdir(), "agent-name-"));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("agentName.derivePrefix", () => {
  it("strips npm scope when present", () => {
    assert.equal(derivePrefix("@ctxr/agent-staff-engineer"), "agent-staff-engineer");
  });
  it("returns the unscoped name unchanged", () => {
    assert.equal(derivePrefix("agent-staff-engineer"), "agent-staff-engineer");
  });
  it("handles dashes, dots, underscores in the name", () => {
    assert.equal(derivePrefix("@scope/my.agent_v2-beta"), "my.agent_v2-beta");
  });
  it("rejects empty or non-string input", () => {
    assert.throws(() => derivePrefix(""));
    assert.throws(() => derivePrefix(undefined));
    assert.throws(() => derivePrefix(null));
    // Numbers, booleans, and other non-strings must also throw directly,
    // not silently coerce to strings (which would produce wrong prefixes).
    assert.throws(() => derivePrefix(123));
    assert.throws(() => derivePrefix(true));
    assert.throws(() => derivePrefix({}));
  });
});

describe("agentName.prefixed", () => {
  it("joins prefix and short name with a single underscore", () => {
    assert.equal(prefixed("agent-staff-engineer", "pr-workflow"), "agent-staff-engineer_pr-workflow");
  });
  it("uses the exported PREFIX_SEPARATOR", () => {
    assert.equal(PREFIX_SEPARATOR, "_");
  });
});

describe("agentName.getAgentPrefix (reads package.json)", () => {
  it("derives the prefix from a real package.json on disk", async () => {
    const dir = join(scratch, "pkg1");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@ctxr/agent-staff-engineer" }));
    const info = await getAgentPrefix(dir);
    assert.equal(info.prefix, "agent-staff-engineer");
    assert.equal(info.packageName, "@ctxr/agent-staff-engineer");
    assert.equal(info.separator, "_");
  });

  it("throws when package.json lacks a usable name", async () => {
    const dir = join(scratch, "pkg2");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.0.0" }));
    await assert.rejects(() => getAgentPrefix(dir), /usable "name"/);
  });

  it("throws when package.json name is not a string (null/number/bool)", async () => {
    const { mkdir } = await import("node:fs/promises");
    for (const [tag, bad] of [["null", null], ["number", 123], ["bool", true]]) {
      const dir = join(scratch, `pkg-${tag}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: bad }));
      await assert.rejects(() => getAgentPrefix(dir), /usable "name"/, `should reject name=${tag}`);
    }
  });
});
