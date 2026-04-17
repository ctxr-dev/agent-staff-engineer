import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOwnerRepo,
  parseProjects,
  parseObservedRepos,
  pickDefaults,
  compose,
  cadenceToIntent,
} from "../scripts/bootstrap.mjs";

describe("bootstrap.parseOwnerRepo", () => {
  it("parses SSH git URL with .git suffix", () => {
    assert.equal(parseOwnerRepo("git@github.com:ctxr-dev/agent-staff-engineer.git"), "ctxr-dev/agent-staff-engineer");
  });

  it("parses HTTPS URL without .git", () => {
    assert.equal(parseOwnerRepo("https://github.com/ctxr-dev/kit"), "ctxr-dev/kit");
  });

  it("returns null for a null remote", () => {
    assert.equal(parseOwnerRepo(null), null);
  });

  it("returns null for non-ASCII owner/repo (defensive)", () => {
    assert.equal(parseOwnerRepo("https://github.com/ow;ner/repo"), null);
  });

  it("returns null for shell-metacharacter attempts", () => {
    assert.equal(parseOwnerRepo("git@host:user/repo$(rm -rf ~).git"), null);
  });
});

describe("bootstrap.parseProjects", () => {
  it("parses a simple dev project", () => {
    const out = parseProjects("ctxr-dev/7", "dev", "full");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "ctxr-dev");
    assert.equal(out[0].number, 7);
    assert.equal(out[0].depth, "full");
  });

  it("skips malformed pairs with non-digit number", () => {
    const out = parseProjects("ctxr-dev/seven", "dev", "full");
    assert.equal(out.length, 0);
  });

  it("skips three-segment inputs", () => {
    const out = parseProjects("a/b/c", "dev", "full");
    assert.equal(out.length, 0);
  });

  it("accepts multiple comma-separated entries", () => {
    const out = parseProjects("a/1, b/2", "dev", "full");
    assert.equal(out.length, 2);
  });

  it("returns empty for blank input", () => {
    assert.deepEqual(parseProjects("", "dev", "full"), []);
  });
});

describe("bootstrap.parseObservedRepos", () => {
  it("parses owner/name pairs", () => {
    const out = parseObservedRepos("foo/lib, foo/docs", "read-only");
    assert.equal(out.length, 2);
    assert.equal(out[0].owner, "foo");
    assert.equal(out[0].name, "lib");
  });
});

describe("bootstrap.cadenceToIntent", () => {
  it("returns wave set by default", () => {
    assert.deepEqual(cadenceToIntent("per-wave"), ["initial", "wave-1", "wave-2", "wave-3", "wave-4", "post-launch"]);
  });
  it("returns version set for per-version", () => {
    assert.deepEqual(cadenceToIntent("per-version"), ["initial", "v1", "v2", "v3", "post-launch"]);
  });
  it("returns minimal set for continuous", () => {
    assert.deepEqual(cadenceToIntent("continuous"), ["initial", "post-launch"]);
  });
});

describe("bootstrap.pickDefaults", () => {
  it("survives when gh is not authed and there is no git remote", () => {
    const detection = {
      git: { remote: null, defaultBranch: "main", ownerRepo: null },
      gh: { authed: false },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    const defaults = pickDefaults(detection);
    assert.ok(Array.isArray(defaults.pushAllowed));
    assert.ok(Array.isArray(defaults.devProjects));
  });
});

describe("bootstrap.compose", () => {
  const detection = {
    git: { remote: "git@github.com:acme/foo.git", defaultBranch: "main", ownerRepo: "acme/foo" },
    gh: { authed: true, login: "jane" },
    stack: { language: ["typescript"], testing: ["vitest"], platform: ["web"] },
    devHints: {},
  };
  const answers = pickDefaults(detection);

  it("produces an ops.config.json with all top-level required keys", () => {
    const cfg = compose(detection, answers, ".claude/agents/agent-staff-engineer");
    for (const k of ["project", "github", "labels", "workflow", "paths", "stack"]) {
      assert.ok(k in cfg, `missing key ${k}`);
    }
    assert.equal(cfg.project.repo, "acme/foo");
    assert.equal(cfg.project.default_branch, "main");
  });

  it("uses the provided bundleRef in body_template and agent_bundle_dir", () => {
    const cfg = compose(detection, answers, ".agents/agents/agent-staff-engineer");
    assert.equal(cfg.paths.agent_bundle_dir, ".agents/agents/agent-staff-engineer");
    assert.ok(cfg.workflow.pr.body_template.startsWith(".agents/agents/agent-staff-engineer/"));
  });
});
