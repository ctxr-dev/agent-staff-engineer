// trackers_github_labels.test.mjs
// Integration tests for the GitHub tracker's `labels` namespace. Uses
// the same fake-gh-on-PATH pattern as trackers_github_issues.test.mjs
// (shim script returns scripted JSON per $FAKE_GH_FIXTURE or sequences
// via $FAKE_GH_SEQUENCE; tees every argv to $FAKE_GH_LOG for
// assertion).
//
// Skipped on Windows (POSIX-only shim; no Windows CI job today).

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
  labels_initial_three)
    printf '%s' '${JSON.stringify({data:{repository:{labels:{nodes:[{id:"L_bug",name:"bug",color:"ff0000",description:"a bug"},{id:"L_feat",name:"feat",color:"00ff00",description:"a feature"},{id:"L_chore",name:"chore",color:"0000ff",description:null}],pageInfo:{hasNextPage:false,endCursor:null}}}}})}'
    ;;
  labels_empty)
    printf '%s' '${JSON.stringify({data:{repository:{labels:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}})}'
    ;;
  repo_null)
    printf '%s' '{"data":{"repository":null}}'
    ;;
  repo_node_id)
    printf '%s' '{"data":{"repository":{"id":"R_widgets"}}}'
    ;;
  create_label_ok)
    printf '%s' '${JSON.stringify({data:{createLabel:{label:{id:"L_new",name:"priority/high",color:"ffaa00"}}}})}'
    ;;
  update_label_ok)
    printf '%s' '${JSON.stringify({data:{updateLabel:{label:{id:"L_bug",name:"bug",color:"ff1111"}}}})}'
    ;;
  delete_label_ok)
    printf '%s' '${JSON.stringify({data:{deleteLabel:{clientMutationId:null}}})}'
    ;;
  list_issues_with_bug)
    printf '%s' '${JSON.stringify({data:{repository:{issues:{nodes:[{id:"I_1",number:1,title:"first",state:"OPEN",url:"u/1",createdAt:"2026-04-20T00:00:00Z",labels:{nodes:[{name:"bug"}],pageInfo:{hasNextPage:false}},milestone:null},{id:"I_2",number:2,title:"second",state:"OPEN",url:"u/2",createdAt:"2026-04-19T00:00:00Z",labels:{nodes:[{name:"bug"},{name:"area/backend"}],pageInfo:{hasNextPage:false}},milestone:null}],pageInfo:{hasNextPage:false,endCursor:null}}}}})}'
    ;;
  issue_node_id)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_abc",number:1,title:"first",state:"OPEN",labels:{nodes:[{id:"L_bug",name:"bug"}],pageInfo:{hasNextPage:false,endCursor:null}}}}}})}'
    ;;
  issue_node_id_2)
    printf '%s' '${JSON.stringify({data:{repository:{issue:{id:"I_def",number:2,title:"second",state:"OPEN",labels:{nodes:[{id:"L_bug",name:"bug"},{id:"L_area",name:"area/backend"}],pageInfo:{hasNextPage:false,endCursor:null}}}}}})}'
    ;;
  labels_all_found_both)
    printf '%s' '${JSON.stringify({data:{repository:{labels:{nodes:[{id:"L_bug",name:"bug"},{id:"L_newname",name:"defect"}],pageInfo:{hasNextPage:false,endCursor:null}}}}})}'
    ;;
  add_labels_ok)
    printf '%s' '${JSON.stringify({data:{addLabelsToLabelable:{labelable:{id:"I_abc"}}}})}'
    ;;
  remove_labels_ok)
    printf '%s' '${JSON.stringify({data:{removeLabelsFromLabelable:{labelable:{id:"I_abc"}}}})}'
    ;;
  *)
    printf '%s' '{"data":null,"errors":[{"message":"fake gh unknown fixture"}]}'
    exit 1
    ;;
esac
`;

async function installFakeGh() {
  const scratch = await mkdtemp(join(tmpdir(), "fake-gh-labels-"));
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
// labels.reconcileLabels — dry-run
// -------------------------------------------------------------------

describe("github labels.reconcileLabels: dry-run plan", skipOpts, () => {
  it("returns an empty plan when declared matches current exactly", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "bug", color: "ff0000", description: "a bug" },
          { name: "feat", color: "00ff00", description: "a feature" },
          { name: "chore", color: "0000ff", description: null },
        ],
      }),
    );
    assert.equal(result.mode, "dry-run");
    assert.equal(result.plan.add.length, 0);
    assert.equal(result.plan.edit.length, 0);
    assert.equal(result.plan.deprecate.length, 0);
    assert.equal(result.plan.unchanged.length, 3);
  });

  it("flags missing labels as 'add'", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "bug", color: "ff0000", description: "a bug" },
          { name: "feat", color: "00ff00", description: "a feature" },
          { name: "chore", color: "0000ff", description: null },
          { name: "priority/high", color: "ffaa00", description: "high priority" },
        ],
      }),
    );
    assert.equal(result.plan.add.length, 1);
    assert.equal(result.plan.add[0].name, "priority/high");
    assert.equal(result.plan.add[0].color, "ffaa00");
  });

  it("flags color changes as 'edit' with the changes list", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "bug", color: "ff1111", description: "a bug" }, // color differs
          { name: "feat", color: "00ff00", description: "a feature" },
          { name: "chore", color: "0000ff", description: null },
        ],
      }),
    );
    assert.equal(result.plan.edit.length, 1);
    assert.equal(result.plan.edit[0].name, "bug");
    assert.deepEqual(result.plan.edit[0].changes, ["color"]);
    assert.equal(result.plan.edit[0].color, "ff1111");
    // description is unchanged; mutation shouldn't include it
    assert.equal(result.plan.edit[0].description, undefined);
  });

  it("allowDeprecate=false leaves the deprecate bucket empty", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [{ name: "bug", color: "ff0000", description: "a bug" }],
      }),
    );
    assert.equal(result.plan.deprecate.length, 0, "no deletions without opt-in");
  });

  it("allowDeprecate=true flags everything not in taxonomy", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [{ name: "bug", color: "ff0000", description: "a bug" }],
        allowDeprecate: true,
      }),
    );
    assert.equal(result.plan.deprecate.length, 2);
    const deprecateNames = result.plan.deprecate.map((d) => d.name).sort();
    assert.deepEqual(deprecateNames, ["chore", "feat"]);
  });

  it("is idempotent: running twice on the same state produces the same empty plan", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const run1 = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "bug", color: "ff0000", description: "a bug" },
          { name: "feat", color: "00ff00", description: "a feature" },
          { name: "chore", color: "0000ff", description: null },
        ],
      }),
    );
    const run2 = await withFakeGhSequence(
      ["labels_initial_three"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "bug", color: "ff0000", description: "a bug" },
          { name: "feat", color: "00ff00", description: "a feature" },
          { name: "chore", color: "0000ff", description: null },
        ],
      }),
    );
    assert.deepEqual(run1.result.plan, run2.result.plan, "idempotent plans match");
  });
});

// -------------------------------------------------------------------
// labels.reconcileLabels — apply
// -------------------------------------------------------------------

describe("github labels.reconcileLabels: apply", skipOpts, () => {
  it("fires createLabel for each add entry after resolving repo id", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result, log } = await withFakeGhSequence(
      ["labels_empty", "repo_node_id", "create_label_ok", "create_label_ok"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "priority/high", color: "ffaa00", description: "h" },
          { name: "priority/low",  color: "aaaaff", description: "l" },
        ],
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    assert.deepEqual(result.applied.added, ["priority/high", "priority/low"]);
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 4, "labels fetch + repo id + 2 createLabel");
    assert.match(lines[2], /createLabel/);
  });

  it("fires updateLabel for edit entries with only changed fields", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result, log } = await withFakeGhSequence(
      ["labels_initial_three", "update_label_ok"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "bug", color: "ff1111", description: "a bug" },
          { name: "feat", color: "00ff00", description: "a feature" },
          { name: "chore", color: "0000ff", description: null },
        ],
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    assert.equal(result.applied.edited.length, 1);
    assert.equal(result.applied.edited[0].name, "bug");
    const updateCall = log.trim().split("\n")[1];
    // The mutation passes color but not description (only color changed).
    assert.match(updateCall, /updateLabel/);
    assert.match(updateCall, /color=ff1111/);
  });

  it("fires deleteLabel only when allowDeprecate is true", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result, log } = await withFakeGhSequence(
      ["labels_initial_three", "delete_label_ok", "delete_label_ok"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [{ name: "bug", color: "ff0000", description: "a bug" }],
        allowDeprecate: true,
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    assert.equal(result.applied.deprecated.length, 2);
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 3, "labels fetch + 2 deleteLabel");
    assert.match(lines[1], /deleteLabel/);
    assert.match(lines[2], /deleteLabel/);
  });
});

// -------------------------------------------------------------------
// labels.reconcileLabels — validation
// -------------------------------------------------------------------

describe("github labels.reconcileLabels: validation", skipOpts, () => {
  it("rejects non-array taxonomy", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.reconcileLabels({}, { taxonomy: "bug" }),
      /taxonomy must be an array/,
    );
  });

  it("rejects entries without a name", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.reconcileLabels({}, { taxonomy: [{ color: "ffaaff" }] }),
      /entry\.name must be a non-empty string/,
    );
  });

  it("rejects duplicate names in the taxonomy", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.reconcileLabels({}, {
        taxonomy: [{ name: "bug" }, { name: "bug" }],
      }),
      /duplicate entry name 'bug'/,
    );
  });

  it("rejects non-6-hex colors", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.reconcileLabels({}, { taxonomy: [{ name: "bug", color: "red" }] }),
      /color must be a 6-hex string/,
    );
  });

  it("accepts color with or without '#' prefix (case-insensitive)", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    // dry-run, no gh call on the empty list.
    const { result } = await withFakeGhSequence(
      ["labels_empty"],
      () => tracker.labels.reconcileLabels({}, {
        taxonomy: [
          { name: "a", color: "#ABCDEF" },
          { name: "b", color: "abcdef" },
        ],
      }),
    );
    assert.equal(result.plan.add[0].color, "abcdef");
    assert.equal(result.plan.add[1].color, "abcdef");
  });
});

// -------------------------------------------------------------------
// labels.relabelBulk
// -------------------------------------------------------------------

describe("github labels.relabelBulk", skipOpts, () => {
  it("returns a dry-run plan listing matching issues without mutating", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result, log } = await withFakeGhSequence(
      ["list_issues_with_bug"],
      () => tracker.labels.relabelBulk({}, {
        plan: [{ from: "bug", to: "defect" }],
      }),
    );
    assert.equal(result.mode, "dry-run");
    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0].issues, [1, 2]);
    assert.equal(result.results[0].changed.length, 0);
    // Only 1 gh call: listIssues. No mutations.
    assert.equal(log.trim().split("\n").length, 1);
  });

  it("applies rename across all matching issues when apply=true", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    const { result } = await withFakeGhSequence(
      [
        "list_issues_with_bug",    // 1: listIssues
        // per-issue relabel path: fetchIssueNodeId (1) + labels (1) + addLabels (1) + removeLabels (1) = 4
        "issue_node_id",           // 2: fetchIssueNodeId for #1
        "labels_all_found_both",   // 3: resolveLabelIds
        "add_labels_ok",           // 4: addLabelsToLabelable for #1
        "remove_labels_ok",        // 5: removeLabelsFromLabelable for #1
        "issue_node_id_2",         // 6: fetchIssueNodeId for #2
        "labels_all_found_both",   // 7: resolveLabelIds
        "add_labels_ok",           // 8: addLabelsToLabelable for #2
        "remove_labels_ok",        // 9: removeLabelsFromLabelable for #2
      ],
      () => tracker.labels.relabelBulk({}, {
        plan: [{ from: "bug", to: "defect" }],
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    assert.deepEqual(result.results[0].changed, [1, 2]);
  });

  it("rejects non-array plan", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.relabelBulk({}, { plan: "not-array" }),
      /plan must be an array/,
    );
  });

  it("rejects from == to", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.relabelBulk({}, { plan: [{ from: "bug", to: "bug" }] }),
      /must differ/,
    );
  });

  it("rejects empty from / to entries", async () => {
    const tracker = makeGithubTracker({ owner: "acme", repo: "widgets" });
    await assert.rejects(
      tracker.labels.relabelBulk({}, { plan: [{ from: "", to: "defect" }] }),
      /entry\.from must be a non-empty string/,
    );
    await assert.rejects(
      tracker.labels.relabelBulk({}, { plan: [{ from: "bug", to: "   " }] }),
      /entry\.to must be a non-empty string/,
    );
  });
});
