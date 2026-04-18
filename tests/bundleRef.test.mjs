import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { portableRef, resolvePortable } from "../scripts/lib/bundleRef.mjs";

describe("portableRef: inside TARGET", () => {
  it("returns the project-relative POSIX path", () => {
    const target = "/work/proj";
    assert.equal(portableRef("/work/proj/agent/skills", target), "agent/skills");
  });
  it("returns '.' when abs equals target", () => {
    assert.equal(portableRef("/work/proj", "/work/proj"), ".");
  });
  it("preserves a one-level child", () => {
    assert.equal(portableRef("/work/proj/x", "/work/proj"), "x");
  });
});

describe("portableRef: inside $HOME", () => {
  const home = homedir();
  it("renders a home-nested path as '~/...'", () => {
    // Use the real home so the helper's os.homedir() matches.
    const abs = join(home, ".claude", "agents", "foo");
    const ref = portableRef(abs, "/outside/proj");
    assert.equal(ref, "~/.claude/agents/foo");
  });
  it("renders $HOME itself as '~'", () => {
    assert.equal(portableRef(home, "/outside/proj"), "~");
  });
  it("does not confuse a path that merely starts with the home prefix", () => {
    // e.g. home = /Users/alice, path = /Users/alice-other/x
    // relative() would still return a ..-prefixed path, so inside-TARGET
    // fails; startsWith check uses home + sep to avoid this false match.
    const sibling = home + "-sibling";
    const ref = portableRef(sibling + "/x", "/outside/proj");
    // Not inside home, not inside target → falls through to absolute.
    assert.equal(ref, `${sibling}/x`);
  });
});

describe("portableRef: fallback", () => {
  it("returns the absolute path when neither rule matches", () => {
    // Use a path that is clearly outside any plausible $HOME and outside target.
    // /opt/... is typical for system-wide installs.
    const ref = portableRef("/opt/agents/foo", "/work/proj");
    assert.equal(ref, "/opt/agents/foo");
  });
});

describe("portableRef: error paths", () => {
  it("throws on empty abs", () => {
    assert.throws(() => portableRef("", "/work/proj"));
  });
  it("throws on empty target", () => {
    assert.throws(() => portableRef("/a", ""));
  });
  it("throws on relative abs", () => {
    assert.throws(() => portableRef("foo/bar", "/work/proj"));
  });
  it("throws on relative target", () => {
    assert.throws(() => portableRef("/a", "foo/bar"));
  });
});

describe("resolvePortable: inverse of portableRef", () => {
  const home = homedir();
  it("resolves a project-relative ref against target", () => {
    assert.equal(
      resolvePortable(".claude/skills/foo/SKILL.md", "/work/proj"),
      "/work/proj/.claude/skills/foo/SKILL.md",
    );
  });
  it("resolves '.' to target itself", () => {
    assert.equal(resolvePortable(".", "/work/proj"), "/work/proj");
  });
  it("expands '~' alone to home", () => {
    assert.equal(resolvePortable("~", "/work/proj"), home);
  });
  it("expands '~/...' to a home-nested absolute path", () => {
    assert.equal(
      resolvePortable("~/.claude/agents/foo", "/work/proj"),
      join(home, ".claude/agents/foo"),
    );
  });
  it("passes a legacy absolute path through unchanged", () => {
    // Back-compat: manifests written before the portable-path fix stored raw
    // absolute paths. resolvePortable must accept them verbatim.
    assert.equal(
      resolvePortable("/Users/alice/work/proj/.claude/skills/foo/SKILL.md", "/work/proj"),
      "/Users/alice/work/proj/.claude/skills/foo/SKILL.md",
    );
  });
  it("round-trips portableRef output back to the original absolute path", () => {
    const target = "/work/proj";
    const abs = "/work/proj/.claude/memory/seed-x.md";
    assert.equal(resolvePortable(portableRef(abs, target), target), abs);
  });
  it("throws on empty ref", () => {
    assert.throws(() => resolvePortable("", "/work/proj"));
  });
  it("throws on relative target", () => {
    assert.throws(() => resolvePortable(".claude/x", "foo/bar"));
  });
});
