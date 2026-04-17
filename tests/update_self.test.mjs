import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSemver, semverCompareDesc, detectInstallMode } from "../scripts/update_self.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("update_self.parseSemver", () => {
  it("parses plain semver", () => {
    assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: "" });
  });
  it("parses without v prefix", () => {
    assert.deepEqual(parseSemver("0.1.0"), { major: 0, minor: 1, patch: 0, prerelease: "" });
  });
  it("parses prerelease", () => {
    assert.deepEqual(parseSemver("v1.0.0-rc.1"), {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: "rc.1",
    });
  });
  it("returns zeros on garbage", () => {
    assert.deepEqual(parseSemver("not-a-tag"), { major: 0, minor: 0, patch: 0, prerelease: "" });
  });
});

describe("update_self.semverCompareDesc", () => {
  it("sorts highest version first", () => {
    const tags = ["v1.0.0", "v2.1.0", "v1.9.9", "v2.0.0"];
    tags.sort(semverCompareDesc);
    assert.deepEqual(tags, ["v2.1.0", "v2.0.0", "v1.9.9", "v1.0.0"]);
  });
  it("ranks prereleases below stable at the same x.y.z", () => {
    const tags = ["v1.0.0", "v1.0.0-rc.2", "v1.0.0-rc.1"];
    tags.sort(semverCompareDesc);
    assert.equal(tags[0], "v1.0.0");
  });
});

describe("update_self.detectInstallMode", () => {
  it("returns 'git' when .git exists", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "upd-self-"));
    await mkdir(join(scratch, ".git"));
    assert.equal(await detectInstallMode(scratch), "git");
    await rm(scratch, { recursive: true, force: true });
  });

  it("returns 'npm' when @ctxr-scoped package.json present and no .git", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "upd-self-"));
    await writeFile(
      join(scratch, "package.json"),
      JSON.stringify({ name: "@ctxr/agent-staff-engineer", version: "0.1.0" })
    );
    assert.equal(await detectInstallMode(scratch), "npm");
    await rm(scratch, { recursive: true, force: true });
  });

  it("returns 'unknown' when neither signal is present", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "upd-self-"));
    await writeFile(join(scratch, "package.json"), JSON.stringify({ name: "misc", version: "0" }));
    assert.equal(await detectInstallMode(scratch), "unknown");
    await rm(scratch, { recursive: true, force: true });
  });
});
