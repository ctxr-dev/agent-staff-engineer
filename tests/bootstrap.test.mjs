import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOwnerRepo,
  parseHostKind,
  parseObservedGithubRepos,
  inferTrackerKind,
  defaultTrackerTarget,
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

describe("bootstrap.parseHostKind", () => {
  it("returns 'github' for github.com hosts", () => {
    assert.equal(parseHostKind("git@github.com:acme/widgets.git"), "github");
    assert.equal(parseHostKind("https://github.com/acme/widgets"), "github");
  });

  it("returns 'gitlab' for gitlab.com and self-hosted GitLab", () => {
    assert.equal(parseHostKind("git@gitlab.com:acme/widgets.git"), "gitlab");
    assert.equal(parseHostKind("https://gitlab.acme.internal/team/widgets"), "gitlab");
  });

  it("returns null for unsupported hosts (bitbucket et al)", () => {
    assert.equal(parseHostKind("git@bitbucket.org:acme/widgets.git"), null);
    assert.equal(parseHostKind("https://codeberg.org/acme/widgets"), null);
  });

  it("returns null for a null / empty url", () => {
    assert.equal(parseHostKind(null), null);
    assert.equal(parseHostKind(""), null);
  });
});

describe("bootstrap.inferTrackerKind", () => {
  const baseDetection = {
    git: { remote: null, defaultBranch: "main", ownerRepo: null },
    gh: { authed: false },
    tracker: { jira: {}, linear: {}, gitlab: {} },
    stack: { language: [], testing: [], platform: [] },
    devHints: {},
  };

  it("prefers git remote host over credential hints", () => {
    const d = {
      ...baseDetection,
      git: { remote: "git@github.com:acme/widgets.git", defaultBranch: "main", ownerRepo: "acme/widgets" },
      tracker: { jira: { hasToken: true }, linear: {}, gitlab: {} },
    };
    assert.equal(inferTrackerKind(d), "github");
  });

  it("falls back to single credential when remote is inconclusive", () => {
    const d = { ...baseDetection, tracker: { jira: { hasToken: true }, linear: {}, gitlab: {} } };
    assert.equal(inferTrackerKind(d), "jira");
  });

  it("returns null when multiple credentials are set (user picks)", () => {
    const d = {
      ...baseDetection,
      tracker: { jira: { hasToken: true }, linear: { hasToken: true }, gitlab: {} },
    };
    assert.equal(inferTrackerKind(d), null);
  });

  it("returns null when nothing is detected", () => {
    assert.equal(inferTrackerKind(baseDetection), null);
  });
});

describe("bootstrap.parseObservedGithubRepos", () => {
  it("parses owner/name pairs into observed githubTracker entries", () => {
    const out = parseObservedGithubRepos("foo/lib, foo/docs", "read-only");
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, "github");
    assert.equal(out[0].owner, "foo");
    assert.equal(out[0].repo, "lib");
    assert.equal(out[0].depth, "read-only");
    assert.deepEqual(out[0].projects, []);
  });

  it("returns an empty array for blank input", () => {
    assert.deepEqual(parseObservedGithubRepos("", "read-only"), []);
  });
});

describe("bootstrap.defaultTrackerTarget", () => {
  const d = {
    git: { remote: "git@github.com:acme/foo.git", defaultBranch: "main", ownerRepo: "acme/foo" },
    gh: { authed: true, login: "jane" },
  };

  it("produces a valid githubTracker with one Project v2 for role=dev", () => {
    const t = defaultTrackerTarget("github", "dev", d);
    assert.equal(t.kind, "github");
    assert.equal(t.owner, "acme");
    assert.equal(t.repo, "foo");
    assert.equal(t.auth_login, "jane");
    assert.equal(t.projects.length, 1);
    assert.equal(t.projects[0].number, 1);
    assert.equal(t.projects[0].depth, "full");
  });

  it("drops the optional repo field for role=release (release trackers span repos)", () => {
    const t = defaultTrackerTarget("github", "release", d);
    assert.equal(t.kind, "github");
    assert.equal("repo" in t, false);
    assert.equal(t.projects[0].depth, "umbrella-only");
  });

  it("produces a schema-valid jiraTracker shell", () => {
    const t = defaultTrackerTarget("jira", "dev", d);
    assert.equal(t.kind, "jira");
    assert.ok("status_values" in t);
    assert.ok("labels_field" in t);
  });

  it("produces a schema-valid linearTracker shell", () => {
    const t = defaultTrackerTarget("linear", "dev", d);
    assert.equal(t.kind, "linear");
    assert.ok("status_values" in t);
  });

  it("produces a schema-valid gitlabTracker shell", () => {
    const t = defaultTrackerTarget("gitlab", "dev", d);
    assert.equal(t.kind, "gitlab");
    assert.equal(t.host, "gitlab.com");
    assert.ok("status_values" in t);
  });

  it("throws on unsupported kinds", () => {
    assert.throws(() => defaultTrackerTarget("bitbucket", "dev", d), /unsupported kind/);
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
      tracker: { jira: {}, linear: {}, gitlab: {} },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    const defaults = pickDefaults(detection);
    assert.ok(Array.isArray(defaults.pushAllowed));
    assert.ok(defaults.devTracker);
    assert.ok(defaults.releaseTracker);
    assert.equal(defaults.devTracker.kind, "github", "falls back to github when nothing is detected");
  });

  it("picks the tracker kind from the git remote host when available", () => {
    const detection = {
      git: { remote: "git@gitlab.com:acme/widgets.git", defaultBranch: "main", ownerRepo: "acme/widgets" },
      gh: { authed: false },
      tracker: { jira: {}, linear: {}, gitlab: {} },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    const defaults = pickDefaults(detection);
    assert.equal(defaults.devTracker.kind, "gitlab");
    assert.equal(defaults.releaseTracker.kind, "gitlab");
  });
});

describe("bootstrap.compose", () => {
  const detection = {
    git: { remote: "git@github.com:acme/foo.git", defaultBranch: "main", ownerRepo: "acme/foo" },
    gh: { authed: true, login: "jane" },
    tracker: { jira: {}, linear: {}, gitlab: {} },
    stack: { language: ["typescript"], testing: ["vitest"], platform: ["web"] },
    devHints: {},
  };
  const answers = pickDefaults(detection);

  it("produces an ops.config.json with all top-level required keys (trackers replaces github)", () => {
    const cfg = compose(detection, answers, ".claude/agents/agent-staff-engineer");
    for (const k of ["project", "trackers", "labels", "workflow", "paths", "stack"]) {
      assert.ok(k in cfg, `missing key ${k}`);
    }
    assert.equal("github" in cfg, false, "legacy github block must not be composed");
    assert.equal(cfg.project.repo, "acme/foo");
    assert.equal(cfg.project.default_branch, "main");
    assert.equal(cfg.trackers.dev.kind, "github");
    assert.equal(cfg.trackers.release.kind, "github");
    assert.deepEqual(cfg.trackers.observed, []);
  });

  it("uses the provided bundleRef in body_template and agent_bundle_dir", () => {
    const cfg = compose(detection, answers, ".agents/agents/agent-staff-engineer");
    assert.equal(cfg.paths.agent_bundle_dir, ".agents/agents/agent-staff-engineer");
    assert.ok(cfg.workflow.pr.body_template.startsWith(".agents/agents/agent-staff-engineer/"));
  });

  it("produces a config that validates against schemas/ops.config.schema.json", async () => {
    // End-to-end: run compose through the real schema. If a compose
    // branch emits a malformed tracker target, schema validation fails
    // here rather than downstream at bootstrap-apply time on a real
    // install. Also guards against silently drifting the compose shape
    // away from the schema when one of the two is edited in isolation.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(here, "..", "schemas", "ops.config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const { validate } = await import("../scripts/lib/schema.mjs");
    void join; // quiet unused warning
    const cfg = compose(detection, answers, ".claude/agents/agent-staff-engineer");
    const v = validate(schema, cfg);
    assert.ok(v.ok, `composed config failed schema: ${JSON.stringify(v.errors ?? null)}`);
  });
});
