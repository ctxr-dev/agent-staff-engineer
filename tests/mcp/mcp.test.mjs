import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeEnvironment, resolveEffectiveTier } from "../../scripts/lib/mcp/probe.mjs";
import { loadManifest, selectServers, buildMcpConfig } from "../../scripts/lib/mcp/register.mjs";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = join(BUNDLE, "mcp", "manifest.yaml");

describe("mcp/probe", () => {
  it("probeEnvironment returns datadogAvailable based on env var", () => {
    const original = process.env.DATADOG_API_KEY;
    try {
      process.env.DATADOG_API_KEY = "test-key";
      assert.equal(probeEnvironment().datadogAvailable, true);
      delete process.env.DATADOG_API_KEY;
      assert.equal(probeEnvironment().datadogAvailable, false);
      process.env.DATADOG_API_KEY = "";
      assert.equal(probeEnvironment().datadogAvailable, false);
    } finally {
      if (original !== undefined) process.env.DATADOG_API_KEY = original;
      else delete process.env.DATADOG_API_KEY;
    }
  });

  it("resolveEffectiveTier downgrades observability when datadog unavailable", () => {
    assert.equal(resolveEffectiveTier("core+observability", { datadogAvailable: false }), "core");
    assert.equal(resolveEffectiveTier("core+observability", { datadogAvailable: true }), "core+observability");
  });

  it("resolveEffectiveTier passes through core and none", () => {
    assert.equal(resolveEffectiveTier("core", { datadogAvailable: true }), "core");
    assert.equal(resolveEffectiveTier("none", { datadogAvailable: true }), "none");
  });
});

describe("mcp/register", () => {
  it("loads the bundled manifest", async () => {
    const manifest = await loadManifest(MANIFEST_PATH);
    assert.ok(manifest.servers.git);
    assert.ok(manifest.servers.filesystem);
    assert.ok(manifest.servers.sqlite);
    assert.ok(manifest.servers.datadog);
    assert.ok(Array.isArray(manifest.rejected));
  });

  it("selectServers returns core servers for core tier", async () => {
    const manifest = await loadManifest(MANIFEST_PATH);
    const servers = selectServers(manifest, "core");
    const names = servers.map((s) => s.name);
    assert.ok(names.includes("git"));
    assert.ok(names.includes("filesystem"));
    assert.ok(names.includes("sqlite"));
    assert.ok(!names.includes("datadog"));
  });

  it("selectServers includes datadog for core+observability tier", async () => {
    const manifest = await loadManifest(MANIFEST_PATH);
    const servers = selectServers(manifest, "core+observability");
    const names = servers.map((s) => s.name);
    assert.ok(names.includes("datadog"));
  });

  it("selectServers returns empty for none tier", async () => {
    const manifest = await loadManifest(MANIFEST_PATH);
    assert.deepEqual(selectServers(manifest, "none"), []);
  });

  it("buildMcpConfig skips non-autoRegistrable servers (datadog)", async () => {
    const manifest = await loadManifest(MANIFEST_PATH);
    const servers = selectServers(manifest, "core+observability");
    const config = buildMcpConfig(servers, "/tmp/test");
    assert.ok(!config.mcpServers.datadog, "datadog should be skipped (autoRegistrable: false)");
    assert.ok(config.mcpServers.git, "core servers should be present");
  });

  it("buildMcpConfig produces Claude Code MCP format", async () => {
    const manifest = await loadManifest(MANIFEST_PATH);
    const servers = selectServers(manifest, "core");
    const config = buildMcpConfig(servers, "/tmp/test");
    assert.ok(config.mcpServers.git);
    assert.equal(config.mcpServers.git.command, "npx");
    assert.ok(config.mcpServers.filesystem);
    assert.ok(config.mcpServers.sqlite);
  });
});
