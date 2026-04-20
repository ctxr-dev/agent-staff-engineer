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
  askBranchPattern,
  askTrackerKind,
  askTrackerTarget,
  SUPPORTED_TRACKER_KINDS,
  pickDefaults,
  compose,
  cadenceToIntent,
  interviewWorkspaceMembers,
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

  // Round-18: jira / linear / gitlab targets must derive depth from
  // role (least privilege on release trackers), matching the github
  // branch. A prior version hardcoded depth="full" for every kind.
  it("picks role-derived depth across every tracker kind (dev=full, release=umbrella-only)", () => {
    for (const kind of ["github", "jira", "linear", "gitlab"]) {
      const dev = defaultTrackerTarget(kind, "dev", d);
      const release = defaultTrackerTarget(kind, "release", d);
      assert.equal(dev.depth, "full", `${kind} dev must default to depth=full`);
      assert.equal(release.depth, "umbrella-only", `${kind} release must default to depth=umbrella-only`);
    }
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
      /valid GitHub repo for the dev tracker after 3 attempts/,
    );
  });

  it("accepts an empty repo for role=release (release trackers legitimately span repos)", async () => {
    // Answers: owner, repo (empty), project-num (empty).
    const ask = makeQueuedAsk(["acme", "", ""]);
    const t = await askTrackerTarget(ask, "github", "release", detection);
    assert.equal("repo" in t, false, "release tracker with empty repo must omit the field entirely");
  });

  // Round-8 T1: release-tracker repo must be trimmed. A whitespace-only
  // answer used to land in target.repo unchanged.
  it("trims whitespace-only repo for role=release and omits the field", async () => {
    const ask = makeQueuedAsk(["acme", "   ", ""]);
    const t = await askTrackerTarget(ask, "github", "release", detection);
    assert.equal("repo" in t, false, "whitespace-only repo must not be persisted");
  });

  // Round-8 T2: owner must be validated / trimmed across both roles
  // via the shared askNonEmpty helper. Empty or whitespace-only owner
  // re-prompts 3 times then throws, same as the dev-repo flow.
  it("re-prompts on empty owner for role=dev and accepts the second non-empty try", async () => {
    // Answers: owner="", owner="acme", repo, project-num.
    const ask = makeQueuedAsk(["", "acme", "widgets", ""]);
    const t = await askTrackerTarget(ask, "github", "dev", detection);
    assert.equal(t.owner, "acme");
  });

  it("throws after 3 empty owner attempts", async () => {
    const ask = makeQueuedAsk(["", "", ""]);
    await assert.rejects(
      () => askTrackerTarget(ask, "github", "dev", detection),
      /valid GitHub owner after 3 attempts/,
    );
  });

  it("trims whitespace-only owner (for both roles)", async () => {
    // dev path
    const askDev = makeQueuedAsk(["   ", "acme", "widgets", ""]);
    const tDev = await askTrackerTarget(askDev, "github", "dev", detection);
    assert.equal(tDev.owner, "acme", "whitespace-only owner must re-prompt");
    // release path (no repo needed)
    const askRelease = makeQueuedAsk(["\t\n", "acme", "", ""]);
    const tRelease = await askTrackerTarget(askRelease, "github", "release", detection);
    assert.equal(tRelease.owner, "acme");
  });

  // Round-9 T5: Jira site + project_key prompts must be validated at
  // ask time with pattern + non-empty checks. site matches
  // <subdomain>.atlassian.net; project key matches the schema's
  // /^[A-Z][A-Z0-9_]*$/.
  it("validates Jira site (must match *.atlassian.net)", async () => {
    // First attempt fails the pattern, second succeeds.
    const ask = makeQueuedAsk(["not-a-host", "acme.atlassian.net", "PLAT"]);
    const t = await askTrackerTarget(ask, "jira", "dev", detection);
    assert.equal(t.site, "acme.atlassian.net");
    assert.equal(t.project, "PLAT");
  });

  it("rejects lowercase or invalid Jira project keys", async () => {
    // Invalid: "plat" (lowercase), "1PLAT" (leading digit); then "PLAT" valid.
    const ask = makeQueuedAsk(["acme.atlassian.net", "plat", "1PLAT", "PLAT"]);
    const t = await askTrackerTarget(ask, "jira", "dev", detection);
    assert.equal(t.project, "PLAT");
  });

  it("throws after 3 invalid Jira site attempts", async () => {
    const ask = makeQueuedAsk(["not-a-host", "also-bad", "still-bad"]);
    await assert.rejects(
      () => askTrackerTarget(ask, "jira", "dev", detection),
      /valid Jira site after 3 attempts/,
    );
  });

  // Round-9 T1: Linear workspace + team prompts must validate.
  // Team pattern mirrors the schema: 2-10 chars, uppercase letters or
  // digits, starting with a letter.
  it("validates Linear workspace and team key", async () => {
    // workspace empty -> reprompt; team "eng" (lowercase) -> reprompt;
    // team "X" (too short) -> reprompt; then valid values.
    const ask = makeQueuedAsk(["", "acme", "eng", "X", "ENG"]);
    const t = await askTrackerTarget(ask, "linear", "dev", detection);
    assert.equal(t.workspace, "acme");
    assert.equal(t.team, "ENG");
  });

  // Round-9 T2: GitLab host + project_path prompts must validate.
  // project_path requires at least two "/"-separated segments.
  it("validates GitLab host and project_path (at least two segments)", async () => {
    // host empty -> reprompt; project_path "onlyone" (single segment)
    // -> reprompt; then valid.
    const ask = makeQueuedAsk(["", "gitlab.com", "onlyone", "acme/widgets"]);
    const t = await askTrackerTarget(ask, "gitlab", "dev", detection);
    assert.equal(t.host, "gitlab.com");
    assert.equal(t.project_path, "acme/widgets");
  });

  it("accepts deeply-nested gitlab project_paths", async () => {
    const ask = makeQueuedAsk(["gitlab.acme.internal", "acme/platform/billing/api"]);
    const t = await askTrackerTarget(ask, "gitlab", "dev", detection);
    assert.equal(t.host, "gitlab.acme.internal");
    assert.equal(t.project_path, "acme/platform/billing/api");
  });

  // Round-18: jira / linear / gitlab interactive paths must also pick
  // role-derived depth (dev=full, release=umbrella-only). github
  // already does; this locks parity across all four kinds so a future
  // revert to hardcoded "full" would fail here.
  it("picks role-derived depth in the interview for every tracker kind", async () => {
    // Jira dev: site + project answers.
    const jiraDev = await askTrackerTarget(
      makeQueuedAsk(["acme.atlassian.net", "PLAT"]),
      "jira", "dev", detection,
    );
    assert.equal(jiraDev.depth, "full");
    const jiraRelease = await askTrackerTarget(
      makeQueuedAsk(["acme.atlassian.net", "PLAT"]),
      "jira", "release", detection,
    );
    assert.equal(jiraRelease.depth, "umbrella-only");

    // Linear dev: workspace + team answers.
    const linearDev = await askTrackerTarget(
      makeQueuedAsk(["acme", "ENG"]),
      "linear", "dev", detection,
    );
    assert.equal(linearDev.depth, "full");
    const linearRelease = await askTrackerTarget(
      makeQueuedAsk(["acme", "ENG"]),
      "linear", "release", detection,
    );
    assert.equal(linearRelease.depth, "umbrella-only");

    // GitLab dev: host + project_path answers.
    const gitlabDev = await askTrackerTarget(
      makeQueuedAsk(["gitlab.com", "acme/widgets"]),
      "gitlab", "dev", detection,
    );
    assert.equal(gitlabDev.depth, "full");
    const gitlabRelease = await askTrackerTarget(
      makeQueuedAsk(["gitlab.com", "acme/widgets"]),
      "gitlab", "release", detection,
    );
    assert.equal(gitlabRelease.depth, "umbrella-only");
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
  // Round-11 T1 changed the behavior: a no-remote environment cannot
  // auto-populate any tracker kind, so pickDefaults throws with a
  // pointed message rather than producing a schema-valid-but-broken
  // config with owner=repo="unknown". Exercise the error here; the
  // adjacent test covers the happy path when a remote exists.
  it("throws when nothing is detectable (no git remote, no credentials)", () => {
    const detection = {
      git: { remote: null, defaultBranch: "main", ownerRepo: null },
      gh: { authed: false },
      tracker: { jira: {}, linear: {}, gitlab: {} },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    assert.throws(
      () => pickDefaults(detection),
      /no tracker kind can be auto-populated/,
    );
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

  // Round-2 T2 + Round-11 T1 combined: when inferTrackerKind picks
  // jira/linear from env tokens and the --yes flow can't
  // auto-populate their required coords, pickDefaults used to fall
  // back to github. Round-11 tightened that: if no git remote exists
  // EITHER, there's also nothing to fall back to (github would get
  // owner=repo="unknown"), so the function now throws with a pointed
  // message telling the user to re-run without --yes.
  it("falls back to github when the inferred kind cannot auto-populate but a git remote exists", () => {
    // Github git remote present + a jira token set. inferTrackerKind
    // picks github via parseHostKind first, so we're not really
    // testing the fallback here -- the real regression test for
    // Round-2 is the next case. This one just locks that a github
    // remote with ownerRepo gives us a github tracker.
    const detection = {
      git: { remote: "git@github.com:acme/foo.git", defaultBranch: "main", ownerRepo: "acme/foo" },
      gh: { authed: true, login: "jane" },
      tracker: { jira: { hasToken: true }, linear: {}, gitlab: {} },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    const defaults = pickDefaults(detection);
    assert.equal(defaults.devTracker.kind, "github");
  });

  // Round-11 T1: --yes hard-fails rather than producing a
  // schema-valid-but-unusable github target with owner=repo="unknown".
  it("throws when --yes cannot auto-populate ANY tracker kind (no remote, no usable credential)", () => {
    const detection = {
      git: { remote: null, defaultBranch: "main", ownerRepo: null },
      gh: { authed: false },
      tracker: { jira: { hasToken: true }, linear: {}, gitlab: {} },
      stack: { language: [], testing: [], platform: [] },
      devHints: {},
    };
    assert.throws(
      () => pickDefaults(detection),
      /no tracker kind can be auto-populated/,
    );
  });
});

describe("bootstrap.askBranchPattern", () => {
  // Minimal ask stub: drains a queue, returns each answer once.
  const makeAsk = (answers) => {
    const queue = [...answers];
    return async () => {
      if (queue.length === 0) throw new Error("ask stub exhausted");
      return queue.shift();
    };
  };

  it("returns the default when the user presses Enter", async () => {
    const out = await askBranchPattern(makeAsk([""]), "feature", "feat/{issue}-{slug}");
    assert.equal(out, "feat/{issue}-{slug}");
  });

  it("returns the user's custom pattern when both {issue} and {slug} are present", async () => {
    const out = await askBranchPattern(
      makeAsk(["{issue}/feature-{slug}"]),
      "feature",
      "feat/{issue}-{slug}",
    );
    assert.equal(out, "{issue}/feature-{slug}");
  });

  it("re-prompts on missing {issue} placeholder", async () => {
    const out = await askBranchPattern(
      makeAsk(["feat/{slug}", "feat/{issue}-{slug}"]),
      "feature",
      "feat/{issue}-{slug}",
    );
    assert.equal(out, "feat/{issue}-{slug}");
  });

  it("re-prompts on missing {slug} placeholder", async () => {
    const out = await askBranchPattern(
      makeAsk(["feat/{issue}", "release/{issue}-{slug}"]),
      "feature",
      "feat/{issue}-{slug}",
    );
    assert.equal(out, "release/{issue}-{slug}");
  });

  it("falls back to the default after 3 invalid attempts (does not throw)", async () => {
    const out = await askBranchPattern(
      makeAsk(["bad1", "bad2", "bad3"]),
      "feature",
      "feat/{issue}-{slug}",
    );
    assert.equal(out, "feat/{issue}-{slug}");
  });
});

describe("bootstrap.interviewWorkspaceMembers", () => {
  // Build a stubbed ask + askYesNo pair that reads from a scripted
  // answer queue. The interview() pattern is ask(question, def) which
  // does `s.trim() || def`; the stub mirrors that exactly so
  // whitespace-only inputs collapse to the default the same way they
  // would during a real interview run. Without the trim, tests would
  // mask whitespace-handling bugs in call sites that assume the
  // returned string is already trimmed.
  const makeAsk = (queue) => async (_q, def = "") => {
    if (queue.length === 0) throw new Error("ask stub exhausted");
    const a = queue.shift();
    const trimmed = String(a ?? "").trim();
    return trimmed === "" ? def : trimmed;
  };
  const makeYesNo = (queue) => async (_q, def = "yes") => {
    if (queue.length === 0) throw new Error("yesno stub exhausted");
    const a = queue.shift();
    if (a === "") return def === "yes";
    return String(a).toLowerCase().startsWith("y");
  };

  const detection = {
    git: { ownerRepo: "acme/primary", defaultBranch: "main" },
    gh: { authed: true, login: "jane" },
    tracker: { jira: {}, linear: {}, gitlab: {} },
    stack: { language: ["typescript"], testing: ["vitest"], platform: ["web"] },
    devHints: {},
  };

  it("returns undefined when the user immediately enters a blank path", async () => {
    const ask = makeAsk([""]);
    const yn = makeYesNo([]);
    const out = await interviewWorkspaceMembers(ask, yn, detection);
    assert.equal(out, undefined);
  });

  it("collects a single member with path='.' and default name", async () => {
    // Queue order (matching helpers' order):
    //   ask: path -> name -> devKind -> github owner -> github repo -> projectNum (blank uses default "1") -> next path (blank stops)
    //   yn: release-tracker?
    const ask = makeAsk([
      ".",               // path
      "primary",         // name
      "github",          // dev kind (askTrackerKind normalises)
      "acme",            // github owner (askNonEmpty)
      "primary",         // github repo (askNonEmpty)
      "1",               // project v2 number (askTrackerTarget)
      "",                // next member path (blank stops the loop)
    ]);
    const yn = makeYesNo(["no"]); // release tracker? no
    const out = await interviewWorkspaceMembers(ask, yn, detection);
    assert.ok(out, "must return a workspace object");
    assert.equal(out.members.length, 1);
    assert.equal(out.members[0].path, ".");
    assert.equal(out.members[0].name, "primary");
    assert.equal(out.members[0].trackers.dev.kind, "github");
    assert.equal(out.members[0].trackers.dev.owner, "acme");
    assert.equal(out.members[0].trackers.dev.repo, "primary");
    assert.equal("release" in out.members[0].trackers, false, "no release when user said no");
  });

  it("caps the loop at 16 members so a runaway stub cannot hang tests forever", async () => {
    // Supply enough answers for 16 iterations of the github member
    // collection. Each iteration consumes: path, name, kind, owner,
    // repo, projectNum (= 6 ask calls). After 16 iterations the loop
    // exits by its own cap, never reaching a 17th "path" prompt.
    const queue = [];
    for (let i = 1; i <= 16; i += 1) {
      queue.push(
        `path-${i}`,
        `name-${i}`,
        "github",
        "acme",
        `repo-${i}`,
        "1",
      );
    }
    const ask = makeAsk(queue);
    const yn = makeYesNo(Array.from({ length: 16 }, () => "no"));
    const out = await interviewWorkspaceMembers(ask, yn, detection);
    assert.ok(out);
    assert.equal(out.members.length, 16, "cap enforced at 16");
  });

  // PR 8 R4 (Copilot): duplicate member paths make resolveMemberFromPath
  // ambiguous (first-match semantics). Prompt-time rejection retries
  // up to 3 times; on exhaustion the loop exits with the members
  // collected so far rather than hanging the interview.
  it("rejects duplicate member paths with a 3-attempt retry + loop exit", async () => {
    // First member: path '.' is accepted. Second member: first
    // attempt repeats '.', then a retry supplies 'libs/shared'.
    const ask = makeAsk([
      // --- member 1 ---
      ".",
      "primary",
      "github",
      "acme",
      "primary",
      "1",
      // --- member 2, attempt 1 (duplicate '.') then attempt 2 ('libs/shared') ---
      ".",
      "libs/shared",
      "shared",
      "github",
      "acme",
      "shared-repo",
      "1",
      // --- end loop ---
      "",
    ]);
    const yn = makeYesNo(["no", "no"]);
    const out = await interviewWorkspaceMembers(ask, yn, detection);
    assert.ok(out);
    assert.equal(out.members.length, 2);
    assert.equal(out.members[0].path, ".");
    assert.equal(out.members[1].path, "libs/shared");
  });

  // PR 8 R4 (Copilot): duplicate member names make
  // pickTrackerForMember ambiguous. Same 3-attempt retry pattern.
  it("rejects duplicate member names with a 3-attempt retry + loop exit", async () => {
    // First member uses default name 'primary'. Second member:
    // attempt 1 tries the same 'primary' (duplicate), attempt 2
    // supplies 'shared'.
    const ask = makeAsk([
      // --- member 1 ---
      ".",
      "primary",
      "github",
      "acme",
      "primary",
      "1",
      // --- member 2 ---
      "libs/shared",
      "primary",   // attempt 1: duplicate name
      "shared",    // attempt 2: unique
      "github",
      "acme",
      "shared-repo",
      "1",
      // --- end loop ---
      "",
    ]);
    const yn = makeYesNo(["no", "no"]);
    const out = await interviewWorkspaceMembers(ask, yn, detection);
    assert.ok(out);
    assert.equal(out.members.length, 2);
    assert.equal(out.members[1].name, "shared");
  });

  // PR 8 R11 (Copilot): askNonEmpty can throw after its own 3-attempt
  // cap on empty inputs; prior to this commit that throw aborted
  // the entire bootstrap run. Now the name-prompt try/catch in
  // interviewWorkspaceMembers converts the throw into a clean
  // loop-exit. The try/catch is defence-in-depth: today every call
  // site passes a non-empty default (so `ask` always returns the
  // default on empty input, and askNonEmpty never exhausts), but
  // a future refactor that allows an empty default would otherwise
  // silently regress and crash the bootstrap mid-workspace. Asserted
  // by inspection of the source; a unit test would need a direct
  // mock of askNonEmpty and would just reassert the try/catch shape
  // we can read in the code.
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

  // PR 7: release umbrellas are now opt-in. When the user says "no" in
  // the interview (the default), compose() must omit `trackers.release`
  // entirely rather than emit an undefined value or an empty object.
  // The consumer contract (release-tracker SKILL.md do_not_trigger_on,
  // dev-loop's link-umbrella step) keys on the key being absent.
  it("omits trackers.release when answers.releaseTracker is undefined", () => {
    const answersNoRelease = { ...answers, releaseTracker: undefined };
    const cfg = compose(detection, answersNoRelease, ".claude/agents/agent-staff-engineer");
    assert.equal("release" in cfg.trackers, false, "trackers.release must be absent, not undefined");
    assert.equal(cfg.trackers.dev.kind, "github", "dev tracker still composed");
    assert.deepEqual(cfg.trackers.observed, [], "observed still composed as empty array");
  });

  // PR 7: when the release tracker is opted out, the PR-creation step
  // must not try to link an umbrella either, even if a stale
  // link_release_umbrella=true survived. Lock the contract that compose
  // sets this to Boolean(a.releaseTracker), not the prior hard-coded
  // true.
  it("sets link_release_umbrella=false when answers.releaseTracker is undefined", () => {
    const answersNoRelease = { ...answers, releaseTracker: undefined };
    const cfg = compose(detection, answersNoRelease, ".claude/agents/agent-staff-engineer");
    assert.equal(cfg.workflow.pr.link_release_umbrella, false);
  });

  it("keeps link_release_umbrella=true when answers.releaseTracker is present", () => {
    const cfg = compose(detection, answers, ".claude/agents/agent-staff-engineer");
    assert.equal(cfg.workflow.pr.link_release_umbrella, true);
  });

  // PR 7: schema now marks trackers.release as optional. A composed
  // config without it must still validate end-to-end. Catches any
  // future schema re-tightening that forgets to flip the `required`
  // array back.
  it("schema accepts a composed config without trackers.release", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const answersNoRelease = { ...answers, releaseTracker: undefined };
    const cfg = compose(detection, answersNoRelease, ".claude/agents/agent-staff-engineer");
    const v = validate(schema, cfg);
    assert.ok(v.ok, `composed config without release failed schema: ${JSON.stringify(v.errors ?? null)}`);
  });

  // PR 7: branch naming is interview-customisable. compose() must
  // carry the answers' branchPatterns through when supplied, and fall
  // back to the conventional defaults when absent (older callers that
  // don't populate it).
  it("uses answers.branchPatterns verbatim when provided", () => {
    const custom = {
      feature: "features/{issue}-{slug}",
      fix: "fixes/{issue}-{slug}",
      chore: "chores/{issue}-{slug}",
      refactor: "refactors/{issue}-{slug}",
      docs: "docs/{issue}-{slug}",
    };
    const answersCustom = { ...answers, branchPatterns: custom };
    const cfg = compose(detection, answersCustom, ".claude/agents/agent-staff-engineer");
    assert.deepEqual(cfg.workflow.branch_patterns, custom);
  });

  it("falls back to the conventional branch defaults when answers.branchPatterns is absent", () => {
    const { branchPatterns: _omit, ...answersMinusBranch } = answers;
    const cfg = compose(detection, answersMinusBranch, ".claude/agents/agent-staff-engineer");
    assert.equal(cfg.workflow.branch_patterns.feature, "feat/{issue}-{slug}");
    assert.equal(cfg.workflow.branch_patterns.fix, "fix/{issue}-{slug}");
    assert.equal(cfg.workflow.branch_patterns.chore, "chore/{issue}-{slug}");
    assert.equal(cfg.workflow.branch_patterns.refactor, "refactor/{issue}-{slug}");
    assert.equal(cfg.workflow.branch_patterns.docs, "docs/{issue}-{slug}");
  });

  // PR 7 R4 (Copilot): compose now merges partial answers.branchPatterns
  // UNDER DEFAULT_BRANCH_PATTERNS so callers (e.g. migration scripts
  // that only override a subset) always produce a schema-valid config
  // with every required key populated. Lock the merge semantics:
  // user-supplied keys win, unset keys come from defaults.
  it("merges partial answers.branchPatterns over defaults", () => {
    const partial = { feature: "features/{issue}-{slug}" };
    const cfg = compose(detection, { ...answers, branchPatterns: partial }, ".claude/agents/agent-staff-engineer");
    assert.equal(cfg.workflow.branch_patterns.feature, "features/{issue}-{slug}", "user override wins");
    assert.equal(cfg.workflow.branch_patterns.fix, "fix/{issue}-{slug}", "unset key filled from defaults");
    assert.equal(cfg.workflow.branch_patterns.chore, "chore/{issue}-{slug}");
    assert.equal(cfg.workflow.branch_patterns.refactor, "refactor/{issue}-{slug}");
    assert.equal(cfg.workflow.branch_patterns.docs, "docs/{issue}-{slug}");
  });

  // Composed branch_patterns must ALWAYS be a fresh object — never a
  // direct reference to the frozen DEFAULT_BRANCH_PATTERNS or to
  // answers.branchPatterns. Mutating the composed result must not
  // back-propagate into the source.
  it("composed branch_patterns is a fresh object (mutation does not leak to answers)", () => {
    const custom = { feature: "features/{issue}-{slug}", fix: "fix/{issue}-{slug}", chore: "chore/{issue}-{slug}", refactor: "refactor/{issue}-{slug}", docs: "docs/{issue}-{slug}" };
    const cfg = compose(detection, { ...answers, branchPatterns: custom }, ".claude/agents/agent-staff-engineer");
    cfg.workflow.branch_patterns.feature = "MUTATED";
    assert.equal(custom.feature, "features/{issue}-{slug}", "answers.branchPatterns must not be mutated");
  });

  // PR 7 R1 (Copilot): askBranchPattern used `includes` for each token
  // separately, accepting {slug}-{issue} order; but the schema's old
  // pattern `.*\{issue\}.*\{slug\}.*` required {issue} first, so the
  // prompt could pass inputs that later failed schema. Schema was
  // loosened to accept either order. Lock the contract: both orders
  // validate; missing-either-token still fails.
  it("schema accepts {slug} before {issue} in branch patterns (either order OK)", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = composeFresh();
    cfg.workflow.branch_patterns.feature = "feat/{slug}-{issue}";
    const v = validate(schema, cfg);
    assert.ok(v.ok, `{slug}-{issue} order must validate: ${JSON.stringify(v.errors ?? null)}`);
  });

  it("schema still rejects a branch pattern missing {issue}", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = composeFresh();
    cfg.workflow.branch_patterns.feature = "feat/{slug}-only";
    const v = validate(schema, cfg);
    assert.equal(v.ok, false, "missing {issue} must fail schema validation");
  });

  it("schema still rejects a branch pattern missing {slug}", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = composeFresh();
    cfg.workflow.branch_patterns.feature = "feat/{issue}-only";
    const v = validate(schema, cfg);
    assert.equal(v.ok, false, "missing {slug} must fail schema validation");
  });

  // PR 7 R5 (Copilot): compose whitelists branchPatterns keys against
  // DEFAULT_BRANCH_PATTERNS because the schema declares
  // `additionalProperties: false` on workflow.branch_patterns. A typo
  // like "fixes" instead of "fix" would otherwise propagate and
  // produce a schema-invalid config. Lock the drop-unknown-keys
  // behaviour so a future rewrite doesn't silently undo it.
  it("compose drops unknown branchPatterns keys (schema has additionalProperties: false)", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const polluted = {
      feature: "feat/{issue}-{slug}",
      fix: "fix/{issue}-{slug}",
      chore: "chore/{issue}-{slug}",
      refactor: "refactor/{issue}-{slug}",
      docs: "docs/{issue}-{slug}",
      fixes: "fixes/{issue}-{slug}",           // typo; must be dropped
      releaseBranch: "release/{slug}",          // extra key; must be dropped
    };
    const cfg = compose(detection, { ...answers, branchPatterns: polluted }, ".claude/agents/agent-staff-engineer");
    assert.equal("fixes" in cfg.workflow.branch_patterns, false, "unknown 'fixes' key must be dropped");
    assert.equal("releaseBranch" in cfg.workflow.branch_patterns, false, "unknown 'releaseBranch' key must be dropped");
    assert.equal(cfg.workflow.branch_patterns.fix, "fix/{issue}-{slug}", "valid keys survive");
    assert.ok(validate(schema, cfg).ok, "composed config with dropped unknown keys must validate");
  });

  // PR 7 R5 (Copilot): trackers.release is gated on `=== undefined`,
  // not truthiness. Bad inputs (null / 0 / "") must propagate so
  // downstream schema validation surfaces them instead of silently
  // omitting the key (which would produce a "valid" config despite
  // the bad caller input).
  it("compose propagates null releaseTracker to fail schema (not silently omit)", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = compose(detection, { ...answers, releaseTracker: null }, ".claude/agents/agent-staff-engineer");
    assert.equal("release" in cfg.trackers, true, "null releaseTracker must still produce a release key");
    assert.equal(cfg.trackers.release, null, "null passes through verbatim");
    assert.equal(validate(schema, cfg).ok, false, "null release must fail schema validation");
  });

  // PR 8: workspace block is optional. Single-repo (answers.workspace
  // undefined) must omit the `workspace` key entirely so the schema's
  // single-repo path is exercised. Bad inputs (null) propagate so
  // downstream schema catches them.
  it("omits cfg.workspace when answers.workspace is undefined (single-repo default)", () => {
    const cfg = compose(detection, answers, ".claude/agents/agent-staff-engineer");
    assert.equal("workspace" in cfg, false, "cfg.workspace must be absent for single-repo");
  });

  it("emits cfg.workspace when answers.workspace is provided (multi-repo)", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const workspace = {
      members: [
        {
          path: ".",
          name: "primary",
          trackers: { dev: { kind: "github", owner: "acme", repo: "primary", projects: [], depth: "full" } },
        },
        {
          path: "libs/shared",
          name: "shared",
          trackers: {
            dev: {
              kind: "jira",
              site: "acme.atlassian.net",
              project: "SHARED",
              depth: "full",
              status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" },
            },
          },
        },
      ],
    };
    const cfg = compose(detection, { ...answers, workspace }, ".claude/agents/agent-staff-engineer");
    assert.deepEqual(cfg.workspace, workspace, "workspace block composed verbatim");
    assert.ok(validate(schema, cfg).ok, `composed config with workspace must validate: ${JSON.stringify(validate(schema, cfg).errors ?? null)}`);
  });

  it("compose propagates null workspace to fail schema (not silently omit)", async () => {
    const schema = await loadSchemaOnce();
    const { validate } = await import("../scripts/lib/schema.mjs");
    const cfg = compose(detection, { ...answers, workspace: null }, ".claude/agents/agent-staff-engineer");
    assert.equal("workspace" in cfg, true, "null workspace must still produce the key");
    assert.equal(cfg.workspace, null);
    assert.equal(validate(schema, cfg).ok, false, "null workspace must fail schema validation");
  });
});
