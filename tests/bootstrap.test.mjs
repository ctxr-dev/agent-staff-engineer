import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOwnerRepo,
  parseHostKind,
  extractHost,
  parseObservedGithubRepos,
  inferTrackerKind,
  defaultTrackerTarget,
  canAutoPopulate,
  isOnPath,
  askTrackerKind,
  SUPPORTED_TRACKER_KINDS,
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

  // Round-2 T3: extend host parsing beyond SCP-style + https:// so
  // standard ssh://git@host/... forms are recognised instead of being
  // silently misclassified as unsupported.
  it("handles ssh://git@host/path remote URLs", () => {
    assert.equal(parseHostKind("ssh://git@gitlab.com/acme/widgets.git"), "gitlab");
    assert.equal(parseHostKind("ssh://git@github.com/acme/widgets.git"), "github");
  });

  it("handles ssh://host/path URLs without a user segment", () => {
    assert.equal(parseHostKind("ssh://gitlab.com/acme/widgets.git"), "gitlab");
  });

  it("strips a :port segment from ssh URLs before matching the host", () => {
    assert.equal(parseHostKind("ssh://git@gitlab.acme.internal:2222/team/widgets.git"), "gitlab");
  });

  it("handles git+ssh:// and git:// (less common but valid) URL forms", () => {
    assert.equal(parseHostKind("git+ssh://git@gitlab.com/acme/widgets.git"), "gitlab");
    assert.equal(parseHostKind("git://github.com/acme/widgets"), "github");
  });
});

describe("bootstrap.extractHost", () => {
  it("extracts the hostname from every supported remote form", () => {
    assert.equal(extractHost("git@github.com:acme/widgets.git"), "github.com");
    assert.equal(extractHost("https://gitlab.com/acme/widgets"), "gitlab.com");
    assert.equal(extractHost("ssh://git@gitlab.acme.internal:2222/team/repo.git"), "gitlab.acme.internal");
    assert.equal(extractHost("git+ssh://git@gitlab.com/acme/widgets.git"), "gitlab.com");
  });
  it("returns null for null / empty / unparseable", () => {
    assert.equal(extractHost(null), null);
    assert.equal(extractHost(""), null);
    assert.equal(extractHost("not a url"), null);
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

  // Round-2 T4: malformed entries previously produced undefined repo
  // fields that passed parse but broke schema validation later with
  // an unhelpful "required property 'repo'" error. Skip + warn instead.
  it("skips entries missing a / separator (with stderr warning)", () => {
    const out = parseObservedGithubRepos("lonely, foo/bar", "read-only");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "foo");
  });

  it("skips three-segment a/b/c entries", () => {
    const out = parseObservedGithubRepos("a/b/c, d/e", "read-only");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "d");
  });

  it("skips entries whose owner or name has invalid chars (non-ASCII, shell metacharacters)", () => {
    const out = parseObservedGithubRepos("ow;ner/ok, ok/rep$o, clean/entry", "read-only");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "clean");
    assert.equal(out[0].repo, "entry");
  });

  it("skips entries with empty segments like a/ or /b", () => {
    const out = parseObservedGithubRepos("a/, /b, keep/me", "read-only");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "keep");
  });
});

describe("bootstrap.canAutoPopulate (--yes guardrail)", () => {
  // Round-2 T2: pickDefaults used to blindly honor inferTrackerKind's
  // jira/linear inference and then schema-validate an empty-site or
  // empty-workspace config, failing with an unactionable error. The
  // canAutoPopulate helper constrains --yes to kinds we can fill
  // from detection alone.
  const githubRemote = { git: { remote: "git@github.com:acme/foo.git", ownerRepo: "acme/foo" } };
  const gitlabRemote = { git: { remote: "git@gitlab.com:acme/foo.git", ownerRepo: "acme/foo" } };
  const noRemote = { git: { remote: null, ownerRepo: null } };

  it("returns true for github when the git remote yielded an owner/repo", () => {
    assert.equal(canAutoPopulate("github", githubRemote), true);
  });
  it("returns false for github when there's no git remote", () => {
    assert.equal(canAutoPopulate("github", noRemote), false);
  });
  it("returns true for gitlab ONLY when the remote parses as a gitlab host", () => {
    assert.equal(canAutoPopulate("gitlab", gitlabRemote), true);
    assert.equal(canAutoPopulate("gitlab", githubRemote), false, "github remote must not satisfy the gitlab check");
    assert.equal(canAutoPopulate("gitlab", noRemote), false);
  });
  it("always returns false for jira and linear (no filesystem-derivable coords)", () => {
    assert.equal(canAutoPopulate("jira", gitlabRemote), false);
    assert.equal(canAutoPopulate("linear", githubRemote), false);
  });
  it("returns false for unknown kinds", () => {
    assert.equal(canAutoPopulate("bitbucket", githubRemote), false);
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
    assert.equal(t.depth, "full", "dev tracker-level depth must be full");
    assert.equal(t.projects.length, 1);
    assert.equal(t.projects[0].number, 1);
    assert.equal(t.projects[0].depth, "full");
  });

  it("drops the optional repo field for role=release (release trackers span repos)", () => {
    const t = defaultTrackerTarget("github", "release", d);
    assert.equal(t.kind, "github");
    assert.equal("repo" in t, false);
    // Round-1 T6: release tracker-level depth mirrors the bound
    // Project v2's umbrella-only depth. Previously the tracker was
    // hardcoded to "full", which let an accepting-defaults user write
    // to every item in the release repo. Least-privilege default.
    assert.equal(t.depth, "umbrella-only", "release tracker-level depth must be umbrella-only");
    assert.equal(t.projects[0].depth, "umbrella-only");
  });

  // Jira / Linear shells intentionally leave required coordinates
  // empty (site, project, workspace, team). They fail schema
  // validation on their own; the user must fill them via the
  // interactive bootstrap or a manual ops.config.json edit. The
  // tests below only lock the shape (kind + status_values present,
  // correct labels_field on jira, etc.), NOT schema validity.
  it("produces the expected jiraTracker shape (required keys present; schema fails until the user fills site/project)", () => {
    const t = defaultTrackerTarget("jira", "dev", d);
    assert.equal(t.kind, "jira");
    assert.equal(t.site, "");
    assert.equal(t.project, "");
    assert.ok("status_values" in t);
    assert.ok("labels_field" in t);
  });

  it("produces the expected linearTracker shape (required keys present; schema fails until the user fills workspace/team)", () => {
    const t = defaultTrackerTarget("linear", "dev", d);
    assert.equal(t.kind, "linear");
    assert.equal(t.workspace, "");
    assert.equal(t.team, "");
    assert.ok("status_values" in t);
  });

  it("produces the expected gitlabTracker shape with gitlab.com fallback when remote is non-gitlab", () => {
    const t = defaultTrackerTarget("gitlab", "dev", d);
    assert.equal(t.kind, "gitlab");
    // Test fixture's remote is github; asking for a gitlab target
    // should NOT inherit github.com as the host (different trackers
    // for different concerns is a valid setup). Fall back to the
    // canonical public host. project_path stays empty for the user
    // to fill in.
    assert.equal(t.host, "gitlab.com");
    assert.equal(t.project_path, "");
    assert.ok("status_values" in t);
  });

  // Round-2 T2: when the remote IS a gitlab URL, host + project_path
  // should both derive from it so --yes produces a schema-valid config.
  it("derives host + project_path from a gitlab git remote", () => {
    const gitlabD = {
      git: {
        remote: "git@gitlab.com:acme/platform/widgets.git",
        defaultBranch: "main",
        ownerRepo: "acme/widgets",
      },
      gh: { authed: false, login: null },
    };
    const t = defaultTrackerTarget("gitlab", "dev", gitlabD);
    assert.equal(t.kind, "gitlab");
    assert.equal(t.host, "gitlab.com");
    // The remote path is `acme/platform/widgets`, with `.git` stripped.
    assert.equal(t.project_path, "acme/platform/widgets");
  });

  it("derives host from a self-hosted gitlab remote with an ssh:// port", () => {
    const selfHosted = {
      git: {
        remote: "ssh://git@gitlab.acme.internal:2222/team/widgets.git",
        defaultBranch: "main",
        ownerRepo: "team/widgets",
      },
      gh: { authed: false, login: null },
    };
    const t = defaultTrackerTarget("gitlab", "dev", selfHosted);
    assert.equal(t.host, "gitlab.acme.internal");
    assert.equal(t.project_path, "team/widgets");
  });

  it("throws on unsupported kinds", () => {
    assert.throws(() => defaultTrackerTarget("bitbucket", "dev", d), /unsupported kind/);
  });
});

describe("bootstrap.askTrackerKind (round-3 T1: normalise + validate)", () => {
  // A tiny fake `ask` that yields scripted answers one at a time.
  // askTrackerKind calls ask(question, default); this stub ignores
  // both and just drains a queue, so tests can assert the exact
  // retry semantics without a real readline.
  function makeFakeAsk(answers) {
    const queue = [...answers];
    return async () => {
      if (queue.length === 0) throw new Error("fake ask exhausted");
      return queue.shift();
    };
  }

  it("returns the normalised kind when the first answer is valid", async () => {
    const out = await askTrackerKind(makeFakeAsk(["github"]), "q", "github");
    assert.equal(out, "github");
  });

  it("accepts capitalised / whitespace-padded input (caught by a prior version's switch default)", async () => {
    for (const raw of ["GitHub", "  jira  ", "LINEAR", "\tGitLab\n"]) {
      const out = await askTrackerKind(makeFakeAsk([raw]), "q", "github");
      assert.ok(SUPPORTED_TRACKER_KINDS.includes(out), `'${raw}' should normalise to a supported kind`);
    }
  });

  it("re-prompts on invalid input and accepts the second try", async () => {
    const out = await askTrackerKind(makeFakeAsk(["bitbucket", "gitlab"]), "q", "github");
    assert.equal(out, "gitlab");
  });

  it("gives up after 3 bad attempts with a pointed error", async () => {
    await assert.rejects(
      () => askTrackerKind(makeFakeAsk(["bitbucket", "codeberg", "fogbugz"]), "q", "github"),
      /valid tracker kind after 3 attempts/,
    );
  });

  it("SUPPORTED_TRACKER_KINDS is frozen (contract lock for downstream switches)", () => {
    assert.ok(Object.isFrozen(SUPPORTED_TRACKER_KINDS));
  });
});

describe("bootstrap.isOnPath (Node-native PATH search)", () => {
  // Regression test for round-1 T4: previously shelled out to
  // `command -v` which is a POSIX builtin, unavailable on Windows
  // shells. The Node-native version iterates PATH and stats each
  // candidate, honouring PATHEXT on win32.
  it("returns true for 'node' (guaranteed on this test runner's PATH)", () => {
    assert.equal(isOnPath("node"), true);
  });

  it("returns false for a sentinel command that cannot exist on PATH", () => {
    // Long random-ish suffix makes accidental collisions astronomically
    // unlikely even on a developer machine with many tools installed.
    assert.equal(isOnPath("this-binary-cannot-possibly-exist-x7a3z9k2q4"), false);
  });

  it("returns false when PATH is empty (short-circuit, no filesystem stats)", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      assert.equal(isOnPath("node"), false);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
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

  // Round-2 T2: when inferTrackerKind picks jira/linear from env
  // tokens but the --yes flow can't auto-populate their required
  // coords, fall back to github so bootstrap produces a schema-valid
  // config. A prior version failed with "required property 'site'"
  // in --yes mode on a machine with JIRA_API_TOKEN set.
  it("falls back to github when the inferred kind cannot be auto-populated from detection", () => {
    const detection = {
      git: { remote: "git@github.com:acme/foo.git", defaultBranch: "main", ownerRepo: "acme/foo" },
      gh: { authed: true, login: "jane" },
      // Only jira has a credential. inferTrackerKind prefers git remote
      // host first (github wins here), so we force inconclusive by
      // removing the remote and having only a jira token. Without the
      // canAutoPopulate guard, pickDefaults would compose a jira
      // target with site="" and fail schema.
      tracker: { jira: { hasToken: true }, linear: {}, gitlab: {} },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    // Force the inconclusive-remote branch: no remote, but a jira token
    // is set.
    detection.git.remote = null;
    detection.git.ownerRepo = null;
    const defaults = pickDefaults(detection);
    assert.equal(defaults.devTracker.kind, "github", "must fall back to github when inferred kind (jira) cannot auto-populate");
    assert.equal(defaults.releaseTracker.kind, "github");
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
