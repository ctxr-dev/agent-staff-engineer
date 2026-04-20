// trackers_github_issues.test.mjs
// Integration tests for the GitHub tracker's `issues` namespace. Uses
// the same fake-gh-on-PATH pattern as trackers_github.test.mjs for the
// review namespace: a POSIX shim script returns scripted JSON per
// $FAKE_GH_FIXTURE and tees every argv into $FAKE_GH_LOG so tests
// assert on the actual request text. A $FAKE_GH_SEQUENCE variant
// scripts multiple fixtures per test when a method makes multiple
// gh calls (createIssue, relabelIssue, updateIssueStatus all do).
//
// Skipped on Windows for the same reason as the review tests:
// the shim is a `#!/bin/sh` script; .github/workflows/ci.yml runs
// ubuntu-latest only, so there is no Windows coverage today.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGithubTracker } from "../scripts/lib/trackers/github.mjs";

const IS_WIN = process.platform === "win32";

const FAKE_GH = `#!/bin/sh
{
  printf 'ARGV:'
  for a in "$@"; do
    sanitized=$(printf '%s' "$a" | tr '\\r\\n' '  ')
    printf ' %s' "$sanitized"
  done
  printf '\\n'
} >> "$FAKE_GH_LOG"
if [ -n "$FAKE_GH_SEQUENCE" ]; then
  call_no=$(wc -l < "$FAKE_GH_LOG" | tr -d ' ')
  FAKE_GH_FIXTURE=$(printf '%s' "$FAKE_GH_SEQUENCE" | awk -v n="$call_no" '{ k = split($0, arr, ","); if (n <= k) print arr[n] }')
fi
case "$FAKE_GH_FIXTURE" in
  issue_node_id)
    printf '%s' '{"data":{"repository":{"issue":{"id":"I_abc","number":42,"title":"existing","state":"OPEN","labels":{"nodes":[{"id":"L_bug","name":"bug"},{"id":"L_area","name":"area/backend"}]}}}}}'
    ;;
  issue_not_found)
    printf '%s' '{"data":{"repository":{"issue":null}}}'
    ;;
  comment_added)
    printf '%s' '{"data":{"addComment":{"commentEdge":{"node":{"id":"IC_new"}}}}}'
    ;;
  get_issue_full)
    printf '%s' '{"data":{"repository":{"issue":{"id":"I_full","number":7,"title":"hello","body":"body text","state":"OPEN","url":"https://github.com/acme/widgets/issues/7","createdAt":"2026-04-20T00:00:00Z","closedAt":null,"author":{"login":"jane"},"assignees":{"nodes":[{"login":"alice"}]},"labels":{"nodes":[{"name":"bug"}]},"milestone":{"number":3,"title":"v1","state":"OPEN"}}}}}'
    ;;
  list_one_page)
    printf '%s' '${JSON.stringify({data:{repository:{issues:{nodes:[{id:"I_1",number:1,title:"first",state:"OPEN",url:"u/1",createdAt:"2026-04-20T00:00:00Z",labels:{nodes:[{name:"bug"},{name:"area/backend"}],pageInfo:{hasNextPage:false}},milestone:{number:3}},{id:"I_2",number:2,title:"second",state:"OPEN",url:"u/2",createdAt:"2026-04-19T00:00:00Z",labels:{nodes:[{name:"feat"}],pageInfo:{hasNextPage:false}},milestone:null}],pageInfo:{hasNextPage:false,endCursor:null}}}}})}'
    ;;
  list_repo_not_found)
    printf '%s' '{"data":{"repository":null}}'
    ;;
  list_truncated_labels)
    printf '%s' '${JSON.stringify({data:{repository:{issues:{nodes:[{id:"I_1",number:1,title:"huge",state:"OPEN",url:"u/1",createdAt:"2026-04-20T00:00:00Z",labels:{nodes:[{name:"x"}],pageInfo:{hasNextPage:true}},milestone:null}],pageInfo:{hasNextPage:false,endCursor:null}}}}})}'
    ;;
  labels_all_found)
    printf '%s' '{"data":{"repository":{"labels":{"nodes":[{"id":"L_bug","name":"bug"},{"id":"L_area","name":"area/backend"},{"id":"L_new","name":"priority/high"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}'
    ;;
  labels_missing_one)
    printf '%s' '{"data":{"repository":{"labels":{"nodes":[{"id":"L_bug","name":"bug"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}'
    ;;
  add_labels_ok)
    printf '%s' '{"data":{"addLabelsToLabelable":{"labelable":{"id":"I_abc"}}}}'
    ;;
  remove_labels_ok)
    printf '%s' '{"data":{"removeLabelsFromLabelable":{"labelable":{"id":"I_abc"}}}}'
    ;;
  search_dedupe_hit)
    printf '%s' '{"data":{"search":{"nodes":[{"id":"I_existing","number":99,"title":"my title","state":"OPEN","repository":{"nameWithOwner":"acme/widgets"}}]}}}'
    ;;
  search_dedupe_miss)
    printf '%s' '{"data":{"search":{"nodes":[]}}}'
    ;;
  repo_node_id)
    printf '%s' '{"data":{"repository":{"id":"R_widgets"}}}'
    ;;
  create_issue_ok)
    printf '%s' '{"data":{"createIssue":{"issue":{"id":"I_new","number":101,"url":"https://github.com/acme/widgets/issues/101"}}}}'
    ;;
  status_query_not_in_status)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_task",projectItems:{nodes:[{id:"PVTI_item1",project:{id:"PVT_proj1",number:3},fieldValueByName:{optionId:"OPT_backlog",name:"Backlog"}}]}}},repositoryOwner:{projectV2:{id:"PVT_proj1",field:{id:"PVTF_status",options:[{id:"OPT_backlog",name:"Backlog"},{id:"OPT_inprogress",name:"In progress"}]}}}}})}'
    ;;
  status_query_already_in_status)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_task",projectItems:{nodes:[{id:"PVTI_item1",project:{id:"PVT_proj1",number:3},fieldValueByName:{optionId:"OPT_inprogress",name:"In progress"}}]}}},repositoryOwner:{projectV2:{id:"PVT_proj1",field:{id:"PVTF_status",options:[{id:"OPT_backlog",name:"Backlog"},{id:"OPT_inprogress",name:"In progress"}]}}}}})}'
    ;;
  update_field_ok)
    printf '%s' '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_item1"}}}}'
    ;;
  *)
    printf '%s' '{"data":null,"errors":[{"message":"fake gh unknown fixture: ""\${FAKE_GH_FIXTURE}"""}]}'
    exit 1
    ;;
esac
`;

async function installFakeGh() {
  const scratch = await mkdtemp(join(tmpdir(), "fake-gh-issues-"));
  const scriptPath = join(scratch, "gh");
  const logPath = join(scratch, "gh.log");
  await writeFile(scriptPath, FAKE_GH, "utf8");
  await writeFile(logPath, "", "utf8");
  await chmod(scriptPath, 0o755);
  return { scratch, logPath };
}

async function withFakeGhSequence(fixtures, fn) {
  const { scratch, logPath } = await installFakeGh();
  const pathBefore = process.env.PATH;
  const fixBefore = process.env.FAKE_GH_FIXTURE;
  const seqBefore = process.env.FAKE_GH_SEQUENCE;
  const logBefore = process.env.FAKE_GH_LOG;
  try {
    process.env.PATH =
      pathBefore === undefined ? scratch : scratch + ":" + pathBefore;
    process.env.FAKE_GH_FIXTURE = "";
    process.env.FAKE_GH_SEQUENCE = fixtures.join(",");
    process.env.FAKE_GH_LOG = logPath;
    const result = await fn();
    const log = await readFile(logPath, "utf8");
    return { result, log };
  } finally {
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    if (fixBefore === undefined) delete process.env.FAKE_GH_FIXTURE;
    else process.env.FAKE_GH_FIXTURE = fixBefore;
    if (seqBefore === undefined) delete process.env.FAKE_GH_SEQUENCE;
    else process.env.FAKE_GH_SEQUENCE = seqBefore;
    if (logBefore === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = logBefore;
    await rm(scratch, { recursive: true, force: true });
  }
}

const skipOpts = IS_WIN
  ? { skip: "windows path shim requires .cmd; no Windows CI job exists today" }
  : {};

// -------------------------------------------------------------------
// comment
// -------------------------------------------------------------------

describe("github issues.comment", skipOpts, () => {
  it("posts addComment with the issue's subjectId after fetching node id", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result, log } = await withFakeGhSequence(
      ["issue_node_id", "comment_added"],
      () => tracker.issues.comment({}, { issueNumber: 42, body: "looks good" }),
    );
    // ghGraphqlMutation returns the `data` root (not the full response),
    // so addComment is a top-level key on the result object.
    assert.equal(result.addComment.commentEdge.node.id, "IC_new");
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 2, "two gh calls: fetch id + addComment");
    assert.match(lines[0], /query\(\$owner: String!.*issue\(number: \$number\)/s);
    assert.match(lines[1], /addComment\(input:/);
    // The body should be passed as an -F variable, not baked into
    // the query string (ghExec's -F variable convention).
    assert.match(lines[1], /body=looks good/);
  });

  it("throws when the issue is not found", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      withFakeGhSequence(["issue_not_found"], () =>
        tracker.issues.comment({}, { issueNumber: 999, body: "x" }),
      ),
      /issue #999 not found/,
    );
  });

  it("validates inputs at the boundary", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.comment({}, { issueNumber: -1, body: "x" }),
      /positive integer/,
    );
    await assert.rejects(
      tracker.issues.comment({}, { issueNumber: 1, body: "" }),
      /non-empty string/,
    );
  });

  it("falls back to target.owner/repo when ctx omits them", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["issue_node_id", "comment_added"],
      () => tracker.issues.comment({}, { issueNumber: 42, body: "hello" }),
    );
    assert.ok(result);
  });

  it("requires owner/repo somewhere (ctx OR target)", async () => {
    const tracker = makeGithubTracker({});
    await assert.rejects(
      tracker.issues.comment({}, { issueNumber: 1, body: "x" }),
      /owner .* is required/,
    );
  });
});

// -------------------------------------------------------------------
// getIssue
// -------------------------------------------------------------------

describe("github issues.getIssue", skipOpts, () => {
  it("returns the full issue shape with assignees, labels, milestone", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["get_issue_full"],
      () => tracker.issues.getIssue({}, { issueNumber: 7 }),
    );
    assert.equal(result.number, 7);
    assert.equal(result.title, "hello");
    assert.equal(result.body, "body text");
    assert.equal(result.state, "OPEN");
    assert.equal(result.author, "jane");
    assert.deepEqual(result.assignees, ["alice"]);
    assert.deepEqual(result.labels, ["bug"]);
    assert.deepEqual(result.milestone, { number: 3, title: "v1", state: "OPEN" });
  });

  it("throws with a pointed error when the issue is missing", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      withFakeGhSequence(["issue_not_found"], () =>
        tracker.issues.getIssue({}, { issueNumber: 999 }),
      ),
      /issue #999 not found/,
    );
  });
});

// -------------------------------------------------------------------
// listIssues
// -------------------------------------------------------------------

describe("github issues.listIssues", skipOpts, () => {
  it("returns the issues in the page with normalised label lists", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["list_one_page"],
      () => tracker.issues.listIssues({}, {}),
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].number, 1);
    assert.deepEqual(result[0].labels, ["bug", "area/backend"]);
    assert.equal(result[0].milestoneNumber, 3);
    assert.equal(result[1].milestoneNumber, null);
  });

  it("filters client-side by label intersection", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["list_one_page"],
      () => tracker.issues.listIssues({}, { labels: ["bug"] }),
    );
    assert.equal(result.length, 1, "only issue 1 has the bug label");
    assert.equal(result[0].number, 1);
  });

  it("filters client-side by milestone number", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["list_one_page"],
      () => tracker.issues.listIssues({}, { milestone: { number: 3 } }),
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].number, 1);
  });

  it("rejects unknown state strings at the boundary", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({}, { state: "pending" }),
      /state must be/,
    );
  });

  // PR 9 R1 (Copilot): listIssues previously assumed repository is
  // non-null. When the repo doesn't exist or the caller lacks
  // access, GraphQL returns repository=null, which used to throw
  // a generic TypeError. Now a pointed error.
  it("throws a pointed error when the repo is missing or inaccessible", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "missing" });
    await assert.rejects(
      withFakeGhSequence(
        ["list_repo_not_found"],
        () => tracker.issues.listIssues({}, {}),
      ),
      /repository acme\/missing not found or inaccessible/,
    );
  });

  // PR 9 R1 (Copilot): labels were fetched with first:20; an issue
  // with >20 labels would silently return a truncated list,
  // breaking client-side label filters. Now fail loud when the
  // labels connection reports hasNextPage=true.
  it("refuses to return a truncated label list on a heavily-labeled issue", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      withFakeGhSequence(
        ["list_truncated_labels"],
        () => tracker.issues.listIssues({}, {}),
      ),
      /more than 100 labels.*truncated/s,
    );
  });
});

// -------------------------------------------------------------------
// relabelIssue
// -------------------------------------------------------------------

describe("github issues.relabelIssue", skipOpts, () => {
  it("no-ops cleanly when both add and remove are empty", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const result = await tracker.issues.relabelIssue({}, {
      issueNumber: 42,
      add: [],
      remove: [],
    });
    assert.deepEqual(result, { added: [], removed: [], issueNumber: 42 });
  });

  it("adds a new label via addLabelsToLabelable after resolving the id", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    // Sequence: fetchIssueNodeId -> labels page -> addLabelsToLabelable
    const { log } = await withFakeGhSequence(
      ["issue_node_id", "labels_all_found", "add_labels_ok"],
      () => tracker.issues.relabelIssue({}, {
        issueNumber: 42,
        add: ["priority/high"],
      }),
    );
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[2], /addLabelsToLabelable/);
    assert.match(lines[2], /"L_new"/);
  });

  it("skips labels the issue already has (delta semantics)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    // The fixture's issue already has "bug". If the caller asks to
    // add "bug", it should collapse to a no-op (no mutation).
    const { result, log } = await withFakeGhSequence(
      ["issue_node_id", "labels_all_found"],
      () => tracker.issues.relabelIssue({}, { issueNumber: 42, add: ["bug"] }),
    );
    assert.deepEqual(result.added, [], "bug was already present; no add expected");
    // Only 2 gh calls: fetch issue + fetch labels. No mutation.
    assert.equal(log.trim().split("\n").length, 2);
  });

  it("throws when requested label names do not exist in the repo", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      withFakeGhSequence(
        ["issue_node_id", "labels_missing_one"],
        () => tracker.issues.relabelIssue({}, {
          issueNumber: 42,
          add: ["nonexistent"],
        }),
      ),
      /labels not found.*'nonexistent'/s,
    );
  });

  // PR 9 R1 (Copilot): duplicates in add[] or remove[] previously
  // produced duplicate label IDs in the mutation input. The method
  // now dedupes within each side before building labelIds.
  it("dedupes within add / remove arrays before the mutation", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    // Queue: fetchIssueNodeId, labels page, addLabelsToLabelable.
    // priority/high is unique on the issue; passing it twice should
    // still produce only one addLabels call with one ID.
    const { log } = await withFakeGhSequence(
      ["issue_node_id", "labels_all_found", "add_labels_ok"],
      () => tracker.issues.relabelIssue({}, {
        issueNumber: 42,
        add: ["priority/high", "priority/high"],
      }),
    );
    const addCall = log.trim().split("\n")[2];
    // The addLabels mutation's labelIds array should contain L_new
    // exactly once, not twice. Asserting on character count of the
    // ID is the simplest proxy.
    const occurrences = (addCall.match(/L_new/g) || []).length;
    assert.equal(occurrences, 1, "dedupe should leave one L_new in the mutation");
  });

  // PR 9 R1 (Copilot): a name appearing in both add AND remove is
  // contradictory and now rejected at the boundary. Silently
  // picking one direction would mask a bug in the caller's plan.
  it("rejects a label that appears in both add and remove", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.relabelIssue({}, {
        issueNumber: 42,
        add: ["bug"],
        remove: ["bug"],
      }),
      /in both add and remove/,
    );
  });
});

// -------------------------------------------------------------------
// createIssue
// -------------------------------------------------------------------

describe("github issues.createIssue", skipOpts, () => {
  it("returns existing issue without creating when title matches open dedupe result", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result, log } = await withFakeGhSequence(
      ["search_dedupe_hit"],
      () => tracker.issues.createIssue({}, { title: "my title" }),
    );
    assert.equal(result.existed, true);
    assert.equal(result.number, 99);
    // Only 1 gh call: the dedupe search. No createIssue mutation.
    assert.equal(log.trim().split("\n").length, 1);
  });

  it("creates a new issue when dedupe misses; returns the new number", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["search_dedupe_miss", "repo_node_id", "create_issue_ok"],
      () => tracker.issues.createIssue({}, { title: "brand new", body: "body" }),
    );
    assert.equal(result.existed, false);
    assert.equal(result.number, 101);
    assert.equal(result.url, "https://github.com/acme/widgets/issues/101");
  });

  it("applies labels after creation via the relabel path", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { log } = await withFakeGhSequence(
      [
        "search_dedupe_miss",       // 1: search
        "repo_node_id",              // 2: resolve repo id
        "create_issue_ok",           // 3: createIssue
        "issue_node_id",             // 4: relabelIssue -> fetch issue
        "labels_all_found",          // 5: relabelIssue -> fetch labels
        "add_labels_ok",             // 6: relabelIssue -> addLabelsToLabelable
      ],
      () => tracker.issues.createIssue({}, {
        title: "brand new",
        labels: ["priority/high"],
      }),
    );
    assert.equal(log.trim().split("\n").length, 6);
  });

  it("renders the body from templateLoader when templateName is set", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    let called = null;
    const ctx = {
      templateLoader: async (name, vars) => {
        called = { name, vars };
        return `rendered body for ${name}`;
      },
      templateVars: { who: "jane" },
    };
    const { log } = await withFakeGhSequence(
      ["search_dedupe_miss", "repo_node_id", "create_issue_ok"],
      () => tracker.issues.createIssue(ctx, {
        title: "templated",
        templateName: "issue-bug.md",
      }),
    );
    assert.deepEqual(called, { name: "issue-bug.md", vars: { who: "jane" } });
    // createIssue mutation line carries the rendered body via -F
    const createCall = log.trim().split("\n")[2];
    assert.match(createCall, /body=rendered body for issue-bug\.md/);
  });

  it("rejects templateName without a templateLoader in ctx", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      withFakeGhSequence(
        ["search_dedupe_miss"],
        () => tracker.issues.createIssue({}, {
          title: "x",
          templateName: "issue.md",
        }),
      ),
      /templateLoader is not a function/,
    );
  });

  it("rejects empty title at the boundary", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "   " }),
      /non-empty string/,
    );
  });

  // PR 9 R1 (Copilot): milestone / assignees were documented but not
  // implemented. Rather than silently dropping them, the method now
  // refuses to accept the keys at all.
  it("rejects milestone / assignees keys (not implemented on this namespace yet)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", milestone: { number: 3 } }),
      /not supported on this namespace yet/,
    );
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", assignees: ["alice"] }),
      /not supported on this namespace yet/,
    );
  });
});

// -------------------------------------------------------------------
// updateIssueStatus
// -------------------------------------------------------------------

describe("github issues.updateIssueStatus", skipOpts, () => {
  const makeProjectTarget = () => ({
    kind: "github",
    owner: "acme",
    repo: "widgets",
    depth: "full",
    projects: [{
      owner: "acme",
      number: 3,
      status_field: "Status",
      status_values: {
        backlog: "Backlog",
        in_progress: "In progress",
        done: "Done",
      },
    }],
  });

  it("refuses to set status 'done' (human-gate contract)", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "done" }),
      /refusing to set status 'done'.*human gate/s,
    );
  });

  it("moves the item when current status differs from target", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    const { result, log } = await withFakeGhSequence(
      ["status_query_not_in_status", "update_field_ok"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.optionId, "OPT_inprogress");
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /updateProjectV2ItemFieldValue/);
  });

  it("no-ops when the item is already in the target status", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    const { result, log } = await withFakeGhSequence(
      ["status_query_already_in_status"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, false);
    assert.equal(result.optionId, "OPT_inprogress");
    // Only the query fires; no mutation.
    assert.equal(log.trim().split("\n").length, 1);
  });

  it("throws when the status vocabulary key has no native mapping", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "ready" }),
      /has no native mapping/,
    );
  });

  it("throws when the target has no projects[0] binding", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets", depth: "full", projects: [] });
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /projects\[0\] binding/,
    );
  });

  // PR 9 R1 (Copilot): status_field previously flowed straight into
  // the query string. A name with quotes / newlines / fancy unicode
  // would silently corrupt the GraphQL query. Now validated against
  // a safe allow-list (letters / digits / space / _ / -) before
  // being inlined (via JSON.stringify for quoting safety).
  it("rejects an unsafe status_field value before running the query", async () => {
    const badTarget = {
      kind: "github",
      owner: "acme",
      repo: "widgets",
      depth: "full",
      projects: [{
        owner: "acme",
        number: 3,
        status_field: 'Status") { id } dangerous {',
        status_values: { backlog: "B", in_progress: "P", done: "D" },
      }],
    };
    const tracker = makeGithubTracker(badTarget);
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /unsafe status_field/,
    );
  });
});
