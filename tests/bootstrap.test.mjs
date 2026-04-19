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
  askTrackerTarget,
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

describe("bootstrap.askTrackerTarget (round-7 T2: dev github repo validation)", () => {
  // Minimal fake-ask helper: yields scripted answers in order.
  // askTrackerTarget calls ask twice (owner, repo) and then once more
  // for the project-number question. The test only cares about the
  // repo prompt's retry semantics.
  const makeQueuedAsk = (answers) => {
    const queue = [...answers];
    return async () => {
      if (queue.length === 0) throw new Error("fake ask exhausted");
      return queue.shift();
    };
  };

  const detection = {
    git: { remote: "git@github.com:acme/foo.git", defaultBranch: "main", ownerRepo: "acme/foo" },
    gh: { authed: true, login: "jane" },
  };

  it("accepts a non-empty repo for role=dev on the first attempt", async () => {
    // Answers: owner, repo, project-num.
    const ask = makeQueuedAsk(["acme", "widgets", ""]);
    const t = await askTrackerTarget(ask, "github", "dev", detection);
    assert.equal(t.repo, "widgets");
  });

  it("re-prompts on empty repo for role=dev and accepts the second non-empty try", async () => {
    const ask = makeQueuedAsk(["acme", "", "widgets", ""]);
    const t = await askTrackerTarget(ask, "github", "dev", detection);
    assert.equal(t.repo, "widgets");
  });

  it("trims whitespace-only repo answers as empty for role=dev", async () => {
    const ask = makeQueuedAsk(["acme", "   ", "\t\n", "widgets", ""]);
    const t = await askTrackerTarget(ask, "github", "dev", detection);
    assert.equal(t.repo, "widgets");
  });

  it("throws after 3 empty attempts for role=dev (pointed error)", async () => {
    const ask = makeQueuedAsk(["acme", "", "", ""]);
    await assert.rejects(
      () => askTrackerTarget(ask, "github", "dev", detection),
      /GitHub repo for the dev tracker after 3 attempts/,
    );
  });

  it("accepts an empty repo for role=release (release trackers legitimately span repos)", async () => {
    // Answers: owner, repo (empty), project-num (empty).
    const ask = makeQueuedAsk(["acme", "", ""]);
    const t = await askTrackerTarget(ask, "github", "release", detection);
    assert.equal("repo" in t, false, "release tracker with empty repo must omit the field entirely");
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

  // Round-6 T4: a non-executable file with a tool-like name that
  // happens to land on PATH should NOT be reported as on-path. Plant
  // one in a scratch PATH entry, confirm isOnPath ignores it, then
  // chmod +x it and confirm isOnPath flips to true. POSIX-only
  // (Windows uses PATHEXT for the executability signal).
  it("rejects a non-executable file on PATH (POSIX-only)", async () => {
    if (process.platform === "win32") return;
    const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const scratch = await mkdtemp(join(tmpdir(), "isonpath-"));
    const toolName = "sentinel-isonpath-probe";
    const binPath = join(scratch, toolName);
    const savedPath = process.env.PATH;
    try {
      await writeFile(binPath, "#!/bin/sh\necho hi\n", "utf8");
      await chmod(binPath, 0o644); // NOT executable
      process.env.PATH = scratch;
      assert.equal(
        isOnPath(toolName),
        false,
        "a non-executable file with the tool's name must not satisfy isOnPath on POSIX",
      );
      await chmod(binPath, 0o755); // executable
      assert.equal(
        isOnPath(toolName),
        true,
        "the same file with the exec bit set should now satisfy isOnPath",
      );
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await rm(scratch, { recursive: true, force: true });
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

  // Load the schema once and reuse across every schema-validation test
  // below. scripts/lib/schema.mjs's ajv instance caches by $id, so
  // re-loading the schema JSON across tests triggers a duplicate-$id
  // error on the second compile. Loading once and passing the same
  // object lets schema.mjs's WeakMap cache the compiled validator
  // while leaving Ajv's $id set to exactly one entry.
  let schemaPromise;
  function loadSchemaOnce() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const { dirname, resolve: resolvePath } = await import("node:path");
        const here = dirname(fileURLToPath(import.meta.url));
        const schemaPath = resolvePath(here, "..", "schemas", "ops.config.schema.json");
        return JSON.parse(await readFile(schemaPath, "utf8"));
      })();
    }
    return schemaPromise;
  }

  // compose() embeds the answers' devTracker / releaseTracker objects
  // by reference, so mutating cfg.trackers.dev.X in one test would
  // silently corrupt answers.devTracker.X for every subsequent test.
  // structuredClone the cfg before any mutation so each test is
  // independent. Hoisting this helper matters: the three schema tests
  // below each delete a field and would otherwise cascade failures.
  const composeFresh = () =>
    structuredClone(compose(detection, answers, ".claude/agents/agent-staff-engineer"));

  it("produces a config that validates against schemas/ops.config.schema.json", async () => {
    // End-to-end: run compose through the real schema. If a compose
    // branch emits a malformed tracker target, schema validation fails
    // here rather than downstream at bootstrap-apply time on a real
    // install. Also guards against silently drifting the compose shape
    // away from the schema when one of the two is edited in isolation.
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const v = validate(schema, composeFresh());
    assert.ok(v.ok, `composed config failed schema: ${JSON.stringify(v.errors ?? null)}`);
  });

  // Round-4 T4: a github dev tracker without `repo` is no longer
  // schema-valid (was silently accepted before). Lock the new
  // conditional requirement so a future schema loosening would fail
  // this test instead of shipping silently.
  it("schema rejects a github dev tracker that omits `repo`", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = composeFresh();
    assert.ok(validate(schema, cfg).ok, "baseline must validate");
    delete cfg.trackers.dev.repo;
    const v = validate(schema, cfg);
    assert.equal(v.ok, false, "github dev tracker without repo must fail schema validation");
    const msg = JSON.stringify(v.errors ?? []);
    assert.match(msg, /repo/, `error should mention 'repo'; got: ${msg}`);
  });

  // Release trackers legitimately span repos, so `repo` stays optional
  // there. Locking this so a future over-eager tightening that forced
  // `repo` on every github tracker would be caught by the tests.
  it("schema allows a github release tracker without `repo`", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = composeFresh();
    delete cfg.trackers.release.repo;
    assert.ok(
      validate(schema, cfg).ok,
      "github release tracker without repo must remain schema-valid",
    );
  });

  // Round-5 T3: `depth` is central to the write-safety model and
  // was previously optional. Now required across every tracker kind
  // (see the required arrays on github/jira/linear/gitlab trackers
  // in schemas/ops.config.schema.json). Lock it.
  it("schema rejects a tracker target missing `depth`", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    for (const role of ["dev", "release"]) {
      const cfg = composeFresh();
      delete cfg.trackers[role].depth;
      const v = validate(schema, cfg);
      assert.equal(
        v.ok,
        false,
        `trackers.${role} without depth must fail schema validation`,
      );
      const msg = JSON.stringify(v.errors ?? []);
      assert.match(msg, /depth/, `error should mention 'depth' for role=${role}; got: ${msg}`);
    }
  });
});
