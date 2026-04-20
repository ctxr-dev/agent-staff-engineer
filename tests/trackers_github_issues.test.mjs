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
  repo_null)
    printf '%s' '{"data":{"repository":null}}'
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
    printf '%s' '${JSON.stringify({data:{search:{nodes:[{id:"I_existing",number:99,title:"my title",state:"OPEN",url:"https://github.com/acme/widgets/issues/99",repository:{nameWithOwner:"acme/widgets"}}],pageInfo:{hasNextPage:false,endCursor:null}}}})}'
    ;;
  search_dedupe_miss)
    printf '%s' '${JSON.stringify({data:{search:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}})}'
    ;;
  search_dedupe_page1_near)
    printf '%s' '${JSON.stringify({data:{search:{nodes:[{id:"I_near",number:50,title:"my title prefix",state:"OPEN",repository:{nameWithOwner:"acme/widgets"}}],pageInfo:{hasNextPage:true,endCursor:"CURSOR1"}}}})}'
    ;;
  search_dedupe_page2_hit)
    printf '%s' '${JSON.stringify({data:{search:{nodes:[{id:"I_exact",number:77,title:"my title",state:"OPEN",repository:{nameWithOwner:"acme/widgets"}}],pageInfo:{hasNextPage:false,endCursor:null}}}})}'
    ;;
  get_issue_too_many_labels)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_full",number:7,title:"hello",body:"x",state:"OPEN",url:"u",createdAt:"c",closedAt:null,author:{login:"j"},assignees:{nodes:[],pageInfo:{hasNextPage:false}},labels:{nodes:[{name:"x"}],pageInfo:{hasNextPage:true}},milestone:null}}}})}'
    ;;
  status_items_page1_miss_other_project)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_task",projectItems:{nodes:[{id:"PVTI_other",project:{id:"PVT_other",number:99},fieldValueByName:null}],pageInfo:{hasNextPage:true,endCursor:"ITEMS_CURSOR"}}}}}})}'
    ;;
  status_items_page2_hit)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_task",projectItems:{nodes:[{id:"PVTI_item1",project:{id:"PVT_proj1",number:3},fieldValueByName:{optionId:"OPT_backlog",name:"Backlog"}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}})}'
    ;;
  create_issue_label_fail_issue_not_found)
    printf '%s' '{"data":{"repository":{"issue":null}}}'
    ;;
  repo_node_id)
    printf '%s' '{"data":{"repository":{"id":"R_widgets"}}}'
    ;;
  create_issue_ok)
    printf '%s' '{"data":{"createIssue":{"issue":{"id":"I_new","number":101,"url":"https://github.com/acme/widgets/issues/101"}}}}'
    ;;
  status_field_query)
    printf '%s' '${JSON.stringify({data:{repositoryOwner:{projectV2:{id:"PVT_proj1",field:{id:"PVTF_status",options:[{id:"OPT_backlog",name:"Backlog"},{id:"OPT_inprogress",name:"In progress"}]}}}}})}'
    ;;
  status_items_current_backlog)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_task",projectItems:{nodes:[{id:"PVTI_item1",project:{id:"PVT_proj1",number:3},fieldValueByName:{optionId:"OPT_backlog",name:"Backlog"}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}})}'
    ;;
  status_items_current_inprogress)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_task",projectItems:{nodes:[{id:"PVTI_item1",project:{id:"PVT_proj1",number:3},fieldValueByName:{optionId:"OPT_inprogress",name:"In progress"}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}})}'
    ;;
  update_field_ok)
    printf '%s' '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_item1"}}}}'
    ;;
  *)
    printf '%s' '{"data":null,"errors":[{"message":"fake gh unknown fixture"}]}'
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

  // PR 9 R4 (Copilot): fetchIssueNodeId previously collapsed repo
  // absence (repository=null) into a misleading "issue not found".
  // Now distinguishes: repo-null throws "repository ... not found";
  // issue-null on an existing repo still surfaces as "issue not found".
  it("throws 'repository not found' when the repo is missing or inaccessible", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "missing" });
    await assert.rejects(
      withFakeGhSequence(
        ["repo_null"],
        () => tracker.issues.comment({}, { issueNumber: 42, body: "x" }),
      ),
      /repository acme\/missing not found or inaccessible/,
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

  // PR 9 R3 (Copilot): getIssue fetched labels/assignees at first:100
  // without a truncation check; a heavier issue would return a
  // silently-truncated list. Now fails loud, matching listIssues.
  it("refuses to return a truncated label list on a heavily-labeled issue", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      withFakeGhSequence(
        ["get_issue_too_many_labels"],
        () => tracker.issues.getIssue({}, { issueNumber: 7 }),
      ),
      /more than 100 labels.*truncated/s,
    );
  });

  // PR 9 R4 (Copilot): getIssue's repo-null path used to surface as
  // "issue not found", which misled debugging when the real cause
  // was a missing / inaccessible repo. Now distinguishes explicitly.
  it("throws 'repository not found or inaccessible' when repository is null", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "missing" });
    await assert.rejects(
      withFakeGhSequence(
        ["repo_null"],
        () => tracker.issues.getIssue({}, { issueNumber: 7 }),
      ),
      /repository acme\/missing not found or inaccessible/,
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

  // PR 9 R7 (Copilot): state:"ALL" previously emitted no `states:`
  // arg, so the GraphQL server applied its default (OPEN), meaning
  // "ALL" behaved identically to "OPEN". Now ALL maps to
  // [OPEN, CLOSED] explicitly.
  it("passes states:[OPEN,CLOSED] when state is 'ALL'", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { log } = await withFakeGhSequence(
      ["list_one_page"],
      () => tracker.issues.listIssues({}, { state: "ALL" }),
    );
    assert.match(log, /states:\s*\[OPEN,\s*CLOSED\]/);
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

  // PR 9 R3 (Copilot): resolveRepoCoords used `||`, which silently
  // fell back to target values when ctx supplied "". That masked
  // caller bugs and could send mutations to the wrong repo. Now
  // empty-string / non-string ctx values throw explicitly.
  it("rejects explicit ctx.owner = '' (no silent fallback to target)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({ owner: "" }, {}),
      /ctx\.owner must be a non-empty string when supplied/,
    );
  });

  it("rejects explicit ctx.repo = '' (no silent fallback to target)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({ repo: "" }, {}),
      /ctx\.repo must be a non-empty string when supplied/,
    );
  });

  // PR 9 R5 (Copilot): whitespace-only values previously passed the
  // length check and then failed later with less-actionable errors.
  // Now treated the same as empty.
  it("rejects whitespace-only ctx.owner / ctx.repo", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({ owner: "   " }, {}),
      /ctx\.owner must be a non-empty string when supplied/,
    );
    await assert.rejects(
      tracker.issues.listIssues({ repo: "\t" }, {}),
      /ctx\.repo must be a non-empty string when supplied/,
    );
  });

  // PR 9 R11 (Copilot): owner/repo values outside GitHub's
  // documented name rules used to flow unchecked into the GraphQL
  // layer (and through gh's shell:true branch on Windows). Now
  // rejected at the boundary via an allow-list regex.
  it("rejects owner/repo values outside GitHub's name rules (allow-list)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({ owner: "acme; rm -rf /" }, {}),
      /owner must match GitHub's owner-name rules/,
    );
    await assert.rejects(
      tracker.issues.listIssues({ repo: "widgets/../../../etc/passwd" }, {}),
      /repo must match GitHub's repo-name rules/,
    );
  });

  // PR 9 R5 (Copilot): listIssues silently ignored non-array labels
  // and accepted NaN/Infinity milestone.number, which filtered out
  // everything without surfacing the caller bug.
  it("rejects non-array labels at the boundary", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({}, { labels: "bug" }),
      /labels must be an array of non-empty strings/,
    );
  });

  it("rejects whitespace-only or non-string entries in labels", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({}, { labels: ["bug", "  "] }),
      /every labels\[\] entry must be a non-empty string/,
    );
    await assert.rejects(
      tracker.issues.listIssues({}, { labels: ["bug", 42] }),
      /every labels\[\] entry must be a non-empty string/,
    );
  });

  it("rejects milestone with non-positive-integer number (NaN, Infinity, 0)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({}, { milestone: { number: NaN } }),
      /milestone\.number must be a positive integer/,
    );
    await assert.rejects(
      tracker.issues.listIssues({}, { milestone: { number: 0 } }),
      /milestone\.number must be a positive integer/,
    );
    await assert.rejects(
      tracker.issues.listIssues({}, { milestone: { number: 1.5 } }),
      /milestone\.number must be a positive integer/,
    );
  });

  it("rejects milestone that isn't an object", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.listIssues({}, { milestone: 3 }),
      /milestone must be null or an object/,
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

  // PR 9 R6 (Copilot): non-string / whitespace-only entries in
  // add/remove used to surface late as "label not found". Now
  // rejected at the boundary with a pointed error.
  it("rejects non-string entries in add[] / remove[]", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.relabelIssue({}, { issueNumber: 42, add: ["bug", 42] }),
      /every add\[\] entry must be a non-empty string/,
    );
    await assert.rejects(
      tracker.issues.relabelIssue({}, { issueNumber: 42, remove: [null] }),
      /every remove\[\] entry must be a non-empty string/,
    );
  });

  it("rejects whitespace-only entries in add[] / remove[]", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.relabelIssue({}, { issueNumber: 42, add: ["   "] }),
      /every add\[\] entry must be a non-empty string/,
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
    // PR 9 R6 (Copilot): dedupe return shape matches create's
    // shape so callers never have to branch on `existed` to read
    // common fields like `url`.
    assert.equal(result.url, "https://github.com/acme/widgets/issues/99");
    assert.equal(typeof result.id, "string");
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

  it("applies labels after creation via the relabel path (targets the newly-created issue)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { log } = await withFakeGhSequence(
      [
        "search_dedupe_miss",       // 1: search
        "repo_node_id",              // 2: resolve repo id
        "create_issue_ok",           // 3: createIssue (returns number=101)
        "issue_node_id",             // 4: relabelIssue -> fetch issue
        "labels_all_found",          // 5: relabelIssue -> fetch labels
        "add_labels_ok",             // 6: relabelIssue -> addLabelsToLabelable
      ],
      () => tracker.issues.createIssue({}, {
        title: "brand new",
        labels: ["priority/high"],
      }),
    );
    const calls = log.trim().split("\n");
    assert.equal(calls.length, 6);
    // PR 9 R10 (Copilot): assert the relabel path uses the created
    // issue's number (101, from the create_issue_ok fixture), not a
    // stale / wrong number. A regression where createIssue forgot
    // to forward `created.number` to relabelIssue would silently
    // relabel a different issue. The fetchIssueNodeId call is the
    // 4th gh invocation (index 3) and carries number=101 as a
    // `-F number=101` flag.
    assert.match(calls[3], /number=101/);
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

  // PR 9 R6 (Copilot): invalid label entries in createIssue used
  // to surface through the downstream relabelIssue call with a
  // misleading "labels not found" message. Now rejected at the
  // boundary so the error points at the createIssue call site.
  it("rejects non-string / whitespace-only label entries on createIssue", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", labels: ["bug", 42] }),
      /every labels\[\] entry must be a non-empty string/,
    );
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", labels: ["   "] }),
      /every labels\[\] entry must be a non-empty string/,
    );
  });

  // PR 9 R11 (Copilot): whitespace-padded labels used to pass the
  // trim-check but be used untrimmed downstream, defeating the
  // delta semantics ("bug " doesn't match "bug" in the issue's
  // current labels). Now normalises to the trimmed value.
  it("normalises whitespace-padded label entries on createIssue", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { log } = await withFakeGhSequence(
      [
        "search_dedupe_miss",
        "repo_node_id",
        "create_issue_ok",
        "issue_node_id",
        "labels_all_found",
        "add_labels_ok",
      ],
      () => tracker.issues.createIssue({}, {
        title: "brand new",
        labels: ["  priority/high  "],
      }),
    );
    const calls = log.trim().split("\n");
    // The addLabelsToLabelable call (index 5) must carry the
    // canonical label id "L_new" (from the labels_all_found
    // fixture, which maps "priority/high" -> "L_new"). If the
    // method had used the untrimmed form, resolveLabelIds would
    // have returned "missing" and the method would have thrown.
    assert.match(calls[5], /L_new/, "trimmed label must resolve to the canonical id");
  });

  // PR 9 R9 (Copilot): non-string body used to flow into the
  // GraphQL `-F body=<value>` and fail with a generic "expected
  // String" server error. Now rejected at the boundary.
  it("rejects non-string body at the boundary", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", body: 42 }),
      /body must be a string when provided/,
    );
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", body: true }),
      /body must be a string when provided/,
    );
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", body: { raw: "text" } }),
      /body must be a string when provided/,
    );
  });

  // PR 9 R8 (Copilot): empty / whitespace templateName was silently
  // treated as "no template" (falsy), ignoring the caller's
  // intent. Now rejected at the boundary.
  it("rejects empty / whitespace / non-string templateName", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", templateName: "" }),
      /templateName must be a non-empty string when supplied/,
    );
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", templateName: "   " }),
      /templateName must be a non-empty string when supplied/,
    );
    await assert.rejects(
      tracker.issues.createIssue({}, { title: "x", templateName: 42 }),
      /templateName must be a non-empty string when supplied/,
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

  // PR 9 R3 (Copilot): dedupe previously requested `search(first: 20)`.
  // Because GitHub search is ranked + substring-based, an exact match
  // could exist but fall past the first page. Now paginates up to
  // DEDUPE_MAX_RESULTS before giving up.
  it("paginates dedupe search until an exact match is found on a later page", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    // Page 1: near-match only. Page 2: exact match. The method
    // should scan both pages and return the existing issue.
    const { result } = await withFakeGhSequence(
      ["search_dedupe_page1_near", "search_dedupe_page2_hit"],
      () => tracker.issues.createIssue({}, { title: "my title" }),
    );
    assert.equal(result.existed, true);
    assert.equal(result.number, 77);
  });

  // PR 9 R3 (Copilot): label apply used to throw and lose the
  // created issue's metadata if the relabel mutation failed.
  // Now wrapped in try/catch so the result carries the created
  // number and surfaces the label failure on `labelError`.
  it("creates the issue + surfaces labelError when the label apply fails", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    // Sequence: dedupe miss, repo id, create ok, relabel fetches
    // issue -> NOT FOUND (simulates a post-create race). The
    // relabel throws, but createIssue still returns the created
    // number with labelError set.
    const { result } = await withFakeGhSequence(
      [
        "search_dedupe_miss",
        "repo_node_id",
        "create_issue_ok",
        "create_issue_label_fail_issue_not_found",
      ],
      () => tracker.issues.createIssue({}, {
        title: "with labels",
        labels: ["priority/high"],
      }),
    );
    assert.equal(result.existed, false);
    assert.equal(result.number, 101);
    assert.ok(result.labelError, "labelError must be populated on label apply failure");
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
      ["status_field_query", "status_items_current_backlog", "update_field_ok"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.optionId, "OPT_inprogress");
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 3, "field query, items query, update mutation");
    assert.match(lines[2], /updateProjectV2ItemFieldValue/);
  });

  it("no-ops when the item is already in the target status", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    const { result, log } = await withFakeGhSequence(
      ["status_field_query", "status_items_current_inprogress"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, false);
    assert.equal(result.optionId, "OPT_inprogress");
    // Only the two queries fire; no mutation.
    assert.equal(log.trim().split("\n").length, 2);
  });

  it("throws when the status vocabulary key has no native mapping", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "ready" }),
      /has no native mapping/,
    );
  });

  // PR 9 R8 (Copilot): whitespace-only status used to pass the
  // length check and fail later with the less-actionable
  // "no native mapping" error.
  it("rejects whitespace-only status at the boundary", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "   " }),
      /status must be a non-empty string key/,
    );
  });

  // PR 9 R8 (Copilot): status with surrounding whitespace now
  // trims cleanly and finds the map entry.
  it("trims whitespace around status before looking up the map", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    const { result } = await withFakeGhSequence(
      ["status_field_query", "status_items_current_backlog", "update_field_ok"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "  in_progress  " }),
    );
    assert.equal(result.changed, true, "padded status must trim and succeed");
  });

  // PR 9 R8 (Copilot): projects[0].number used to only check
  // typeof === "number"; NaN/Infinity/decimal slipped through and
  // failed later in GraphQL. Now asserted as positive integer.
  it("rejects invalid projects[0].number (NaN, decimal, zero) at runtime", async () => {
    const make = (badNumber) => makeGithubTracker({
      kind: "github",
      owner: "acme",
      repo: "widgets",
      depth: "full",
      projects: [{
        owner: "acme",
        number: badNumber,
        status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" },
      }],
    });
    await assert.rejects(
      make(NaN).issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /projects\[0\]\.number must be a positive integer/,
    );
    await assert.rejects(
      make(1.5).issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /projects\[0\]\.number must be a positive integer/,
    );
    await assert.rejects(
      make(0).issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /projects\[0\]\.number must be a positive integer/,
    );
  });

  it("throws when the target has no projects[0] binding", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets", depth: "full", projects: [] });
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /projects\[0\] binding/,
    );
  });

  // PR 9 R3 (Copilot): projectItems was fetched first:20, so an
  // issue linked to >20 projects could miss the target. Now
  // paginates until the target project is found or pages exhaust.
  it("paginates issue.projectItems to find the target project on page 2", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    const { result, log } = await withFakeGhSequence(
      [
        "status_field_query",
        "status_items_page1_miss_other_project",
        "status_items_page2_hit",
        "update_field_ok",
      ],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.optionId, "OPT_inprogress");
    assert.equal(log.trim().split("\n").length, 4, "field + items page1 + items page2 + update");
  });

  // PR 9 R1 (Copilot): status_field previously flowed straight into
  // the query string. A name with quotes / newlines / fancy unicode
  // would silently corrupt the GraphQL query. Now validated against
  // a safe allow-list (letters / digits / space / _ / -) before
  // being inlined (via JSON.stringify for quoting safety).
  it("rejects an unsafe status_field value containing control chars before running the query", async () => {
    // Prior iterations used a strict allow-list regex; R7 loosened
    // that (JSON.stringify already makes inline injection safe) so
    // punctuation / emoji pass through. The runtime now rejects
    // only genuinely dangerous inputs: control chars (GraphQL
    // rejects malformed) and length > 256. Use a NUL byte here so
    // the test exercises the remaining guard.
    const badTarget = {
      kind: "github",
      owner: "acme",
      repo: "widgets",
      depth: "full",
      projects: [{
        owner: "acme",
        number: 3,
        status_field: "Status\u0000injection",
        status_values: { backlog: "B", in_progress: "P", done: "D" },
      }],
    };
    const tracker = makeGithubTracker(badTarget);
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /unsafe status_field.*control characters/,
    );
  });

  // PR 9 R7 (Copilot): the runtime previously hard-rejected any
  // character outside `[A-Za-z0-9 _-]`, diverging from the schema's
  // `type: "string"`. Now unusual-but-safe names (punctuation,
  // emoji) flow through via JSON.stringify, matching the schema.
  // Assert by running the full happy path with such a name: if
  // validation were still strict, the call would throw early on
  // the status_field guard; instead it reaches the field query
  // and (with the same fixture as the happy path) succeeds.
  it("accepts unusual but safe status_field names (punctuation, emoji)", async () => {
    const tracker = makeGithubTracker({
      kind: "github",
      owner: "acme",
      repo: "widgets",
      depth: "full",
      projects: [{
        owner: "acme",
        number: 3,
        status_field: "Status / Stage \uD83D\uDE80",
        status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" },
      }],
    });
    // Same fixture stack as the happy-path move test: the field
    // query fixture carries canonical option names, so the full
    // flow works regardless of what status_field is (the field
    // name is passed inline but the fixture doesn't interpolate).
    const { result } = await withFakeGhSequence(
      ["status_field_query", "status_items_current_backlog", "update_field_ok"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, true, "emoji / punctuation status_field must not trip the guard");
  });

  // PR 9 R4 (Copilot): the earlier `status_field || "Status"` form
  // silently fell back on empty string / non-string, masking
  // misconfigurations like `status_field: ""`. Now present-but-
  // invalid values throw explicitly; nullish-only values fall
  // back to the default.
  it("rejects present-but-empty status_field (no silent default fallback)", async () => {
    const tracker = makeGithubTracker({
      kind: "github",
      owner: "acme",
      repo: "widgets",
      depth: "full",
      projects: [{
        owner: "acme",
        number: 3,
        status_field: "",
        status_values: { backlog: "B", in_progress: "P", done: "D" },
      }],
    });
    await assert.rejects(
      tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      /status_field must be a non-empty string when provided/,
    );
  });

  // PR 9 R6 (Copilot): updateIssueStatus's items query also used
  // to collapse repository=null into "issue not found", masking
  // auth / targeting failures. Now distinguishes explicitly.
  it("throws 'repository not found' on updateIssueStatus when repo is null", async () => {
    const tracker = makeGithubTracker(makeProjectTarget());
    // Sequence: field query succeeds, items query returns repo=null.
    await assert.rejects(
      withFakeGhSequence(
        ["status_field_query", "repo_null"],
        () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
      ),
      /repository acme\/widgets not found or inaccessible/,
    );
  });

  it("falls back to 'Status' when status_field is absent", async () => {
    // Target omits status_field entirely; schema validation in real
    // configs applies `default: "Status"` via Ajv, but the runtime
    // must also handle the absent case. The fixture is non-in-status
    // so we exercise the full update path.
    const tracker = makeGithubTracker({
      kind: "github",
      owner: "acme",
      repo: "widgets",
      depth: "full",
      projects: [{
        owner: "acme",
        number: 3,
        status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" },
      }],
    });
    const { result } = await withFakeGhSequence(
      ["status_field_query", "status_items_current_backlog", "update_field_ok"],
      () => tracker.issues.updateIssueStatus({}, { issueNumber: 42, status: "in_progress" }),
    );
    assert.equal(result.changed, true);
  });
});
