// trackers_github_projects.test.mjs
// Integration tests for the GitHub tracker's `projects` namespace.
// Uses the same fake-gh-on-PATH pattern as the labels / issues tests.

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

// Pre-build JSON fixture payloads as JS objects, then interpolate the
// already-stringified form into the shell shim. Doing the stringify
// OUTSIDE the shell template literal eliminates brace-counting errors
// and keeps the JSON human-readable in the source.
const FIX = {
  project_resolve_full: {
    data: {
      repositoryOwner: {
        projectV2: {
          id: "PVT_proj1",
          title: "Dev Board",
          fields: {
            nodes: [
              { id: "PVTF_status", name: "Status", dataType: "SINGLE_SELECT",
                options: [
                  { id: "OPT_backlog", name: "Backlog" },
                  { id: "OPT_inprogress", name: "In progress" },
                ],
              },
              { id: "PVTF_priority", name: "Priority", dataType: "SINGLE_SELECT",
                options: [
                  { id: "OPT_p0", name: "P0" },
                  { id: "OPT_p1", name: "P1" },
                ],
              },
              { id: "PVTF_estimate", name: "Estimate", dataType: "NUMBER" },
              { id: "PVTF_targetdate", name: "Target Date", dataType: "DATE" },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  },
  project_resolve_missing_fields: {
    data: {
      repositoryOwner: {
        projectV2: {
          id: "PVT_proj1",
          title: "Dev Board",
          fields: {
            nodes: [
              { id: "PVTF_status", name: "Status", dataType: "SINGLE_SELECT", options: [] },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  },
  project_not_found: { data: { repositoryOwner: null } },
  list_items_one_page: {
    data: {
      repositoryOwner: {
        projectV2: {
          items: {
            nodes: [
              {
                id: "PVTI_1",
                type: "ISSUE",
                content: { __typename: "Issue", number: 1, title: "first", url: "u/1", state: "OPEN" },
                fieldValues: {
                  nodes: [
                    { field: { name: "Status" }, name: "In progress", optionId: "OPT_inprogress" },
                    { field: { name: "Priority" }, name: "P0", optionId: "OPT_p0" },
                    { field: { name: "Estimate" }, number: 3 },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
              {
                id: "PVTI_2",
                type: "ISSUE",
                content: { __typename: "Issue", number: 2, title: "second", url: "u/2", state: "OPEN" },
                fieldValues: {
                  nodes: [
                    { field: { name: "Status" }, name: "Backlog", optionId: "OPT_backlog" },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  },
  list_items_page1: {
    data: {
      repositoryOwner: {
        projectV2: {
          items: {
            nodes: [
              {
                id: "PVTI_1",
                type: "ISSUE",
                content: { __typename: "Issue", number: 1, title: "first", url: "u/1", state: "OPEN" },
                fieldValues: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "CURSOR1" },
          },
        },
      },
    },
  },
  list_items_page2: {
    data: {
      repositoryOwner: {
        projectV2: {
          items: {
            nodes: [
              {
                id: "PVTI_2",
                type: "ISSUE",
                content: { __typename: "Issue", number: 2, title: "second", url: "u/2", state: "OPEN" },
                fieldValues: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  },
  update_field_ok: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } },
  create_field_ok: { data: { createProjectV2Field: { projectV2Field: { id: "PVTF_new", name: "New Field" } } } },
};

const FIX_JSON = Object.fromEntries(
  Object.entries(FIX).map(([k, v]) => [k, JSON.stringify(v)]),
);

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
  project_resolve_full)
    printf '%s' '${FIX_JSON.project_resolve_full}'
    ;;
  project_resolve_missing_fields)
    printf '%s' '${FIX_JSON.project_resolve_missing_fields}'
    ;;
  project_not_found)
    printf '%s' '${FIX_JSON.project_not_found}'
    ;;
  list_items_one_page)
    printf '%s' '${FIX_JSON.list_items_one_page}'
    ;;
  list_items_page1)
    printf '%s' '${FIX_JSON.list_items_page1}'
    ;;
  list_items_page2)
    printf '%s' '${FIX_JSON.list_items_page2}'
    ;;
  update_field_ok)
    printf '%s' '${FIX_JSON.update_field_ok}'
    ;;
  create_field_ok)
    printf '%s' '${FIX_JSON.create_field_ok}'
    ;;
  *)
    printf '%s' '{"data":null,"errors":[{"message":"fake gh unknown fixture"}]}'
    exit 1
    ;;
esac
`;

async function installFakeGh() {
  const scratch = await mkdtemp(join(tmpdir(), "fake-gh-projects-"));
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

const makeTarget = (overrides = {}) => ({
  kind: "github",
  owner: "acme",
  repo: "widgets",
  depth: "full",
  projects: [
    {
      owner: "acme",
      number: 3,
      status_field: "Status",
      status_values: { backlog: "Backlog", in_progress: "In progress", done: "Done" },
      fields: ["Priority", "Estimate", "Target Date"],
    },
  ],
  ...overrides,
});

// -------------------------------------------------------------------
// projects.listProjectItems
// -------------------------------------------------------------------

describe("github projects.listProjectItems", skipOpts, () => {
  it("returns items on one page with normalised field values", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result } = await withFakeGhSequence(
      ["list_items_one_page"],
      () => tracker.projects.listProjectItems({}, { projectNumber: 3 }),
    );
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].type, "ISSUE");
    assert.deepEqual(result.items[0].fieldValues.Priority, { name: "P0", optionId: "OPT_p0" });
    assert.equal(result.items[0].fieldValues.Estimate, 3);
    assert.equal(result.items[1].fieldValues.Status.name, "Backlog");
    assert.equal(result.hasNextPage, false);
  });

  it("paginates across pages until limit hits", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result, log } = await withFakeGhSequence(
      ["list_items_page1", "list_items_page2"],
      () => tracker.projects.listProjectItems({}, { projectNumber: 3, limit: 100 }),
    );
    assert.equal(result.items.length, 2);
    assert.equal(log.trim().split("\n").length, 2, "two gh calls for pagination");
  });

  it("returns accurate endCursor when limit < first so a resume fetches the next item", async () => {
    // Regression: mid-page truncation must never return an endCursor
    // for an item the caller didn't receive. Implementation caps
    // per-request `first` to the remaining budget, so the server
    // returns at most `limit` items per call and endCursor always
    // points at the last returned node.
    const tracker = makeGithubTracker(makeTarget());
    const { result: firstResult } = await withFakeGhSequence(
      ["list_items_page1"],
      () => tracker.projects.listProjectItems({}, { projectNumber: 3, first: 100, limit: 1 }),
    );
    assert.equal(firstResult.items.length, 1);
    assert.equal(firstResult.hasNextPage, true);
    assert.ok(firstResult.endCursor, "first page should expose an endCursor for resuming");
    assert.equal(firstResult.items[0].id, "PVTI_1");

    const { result: secondResult } = await withFakeGhSequence(
      ["list_items_page2"],
      () => tracker.projects.listProjectItems({}, {
        projectNumber: 3,
        first: 100,
        limit: 1,
        after: firstResult.endCursor,
      }),
    );
    assert.equal(secondResult.items.length, 1);
    assert.equal(secondResult.items[0].id, "PVTI_2");
    assert.notDeepEqual(
      secondResult.items[0],
      firstResult.items[0],
      "resuming with after:endCursor should return the next item, not repeat the first",
    );
  });

  it("throws when project is not found", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      withFakeGhSequence(
        ["project_not_found"],
        () => tracker.projects.listProjectItems({}, { projectNumber: 99 }),
      ),
      /Project v2 #99 not found/,
    );
  });

  it("rejects invalid projectNumber at the boundary", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.listProjectItems({}, { projectNumber: 0 }),
      /projectNumber must be a positive integer/,
    );
    await assert.rejects(
      tracker.projects.listProjectItems({}, { projectNumber: "abc" }),
      /projectNumber must be a positive integer/,
    );
  });

  it("rejects first outside 1-100 range", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.listProjectItems({}, { projectNumber: 3, first: 200 }),
      /first must be an integer 1-100/,
    );
  });
});

// -------------------------------------------------------------------
// projects.updateProjectField
// -------------------------------------------------------------------

describe("github projects.updateProjectField", skipOpts, () => {
  it("updates a single-select field via the option-name -> id mapping", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result, log } = await withFakeGhSequence(
      ["project_resolve_full", "update_field_ok"],
      () => tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Priority",
        value: { singleSelect: "P0" },
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    assert.match(log.trim().split("\n")[1], /updateProjectV2ItemFieldValue/);
    assert.match(log.trim().split("\n")[1], /OPT_p0/);
  });

  it("updates a number field", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result, log } = await withFakeGhSequence(
      ["project_resolve_full", "update_field_ok"],
      () => tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Estimate",
        value: { number: 5 },
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    // Number is inlined, not passed as a variable.
    assert.match(log.trim().split("\n")[1], /number:\s*5/);
  });

  it("updates a date field with ISO-shape validation", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result } = await withFakeGhSequence(
      ["project_resolve_full", "update_field_ok"],
      () => tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Target Date",
        value: { date: "2026-04-21" },
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
  });

  it("refuses to write to a field not declared in trackers.projects[].fields", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "SecretField",
        value: { text: "x" },
        apply: true,
      }),
      /field 'SecretField' is not declared in trackers\.projects\[#3\]\.fields/,
    );
  });

  it("allows Status (implicit) even without listing it in fields", async () => {
    const target = makeTarget();
    // Remove Status from declared fields; should still be allowed
    // because Status is the implicit status_field for this project.
    target.projects[0].fields = ["Priority"];
    const tracker = makeGithubTracker(target);
    const { result } = await withFakeGhSequence(
      ["project_resolve_full", "update_field_ok"],
      () => tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Status",
        value: { singleSelect: "In progress" },
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
  });

  it("dry-run returns mutationArgs without firing", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result, log } = await withFakeGhSequence(
      ["project_resolve_full"],
      () => tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Priority",
        value: { singleSelect: "P0" },
      }),
    );
    assert.equal(result.mode, "dry-run");
    assert.equal(result.mutationArgs.kind, "singleSelect");
    // Only the resolve call fired; no mutation.
    assert.equal(log.trim().split("\n").length, 1);
  });

  it("rejects a singleSelect option that doesn't exist on the field", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      withFakeGhSequence(
        ["project_resolve_full"],
        () => tracker.projects.updateProjectField({}, {
          projectNumber: 3,
          itemId: "PVTI_1",
          field: "Priority",
          value: { singleSelect: "P99" },
          apply: true,
        }),
      ),
      /option 'P99' not found on field 'Priority'/,
    );
  });

  it("rejects value with multiple kinds", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Priority",
        value: { singleSelect: "P0", number: 5 },
        apply: true,
      }),
      /value must have exactly one of/,
    );
  });

  it("rejects malformed date strings", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.updateProjectField({}, {
        projectNumber: 3,
        itemId: "PVTI_1",
        field: "Target Date",
        value: { date: "2026/04/21" },
        apply: true,
      }),
      /value\.date must be an ISO date/,
    );
  });
});

// -------------------------------------------------------------------
// projects.reconcileProjectFields
// -------------------------------------------------------------------

describe("github projects.reconcileProjectFields", skipOpts, () => {
  it("returns a dry-run plan with missing vs present", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result } = await withFakeGhSequence(
      ["project_resolve_missing_fields"],
      () => tracker.projects.reconcileProjectFields({}, {
        projectNumber: 3,
        declared: ["Status", "Priority", "Estimate"],
      }),
    );
    assert.equal(result.mode, "dry-run");
    assert.deepEqual(result.present, ["Status"]);
    assert.deepEqual(result.missing.sort(), ["Estimate", "Priority"]);
  });

  it("creates only the missing fields when apply=true", async () => {
    const tracker = makeGithubTracker(makeTarget());
    const { result, log } = await withFakeGhSequence(
      ["project_resolve_missing_fields", "create_field_ok", "create_field_ok"],
      () => tracker.projects.reconcileProjectFields({}, {
        projectNumber: 3,
        declared: ["Status", "Priority", "Estimate"],
        apply: true,
      }),
    );
    assert.equal(result.mode, "applied");
    assert.deepEqual(result.created.sort(), ["Estimate", "Priority"]);
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 3, "resolve + 2 createField");
    assert.match(lines[1], /createProjectV2Field/);
  });

  it("rejects non-array declared list", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.reconcileProjectFields({}, {
        projectNumber: 3,
        declared: "Status",
      }),
      /declared must be an array/,
    );
  });

  it("rejects empty or non-string declared entries", async () => {
    const tracker = makeGithubTracker(makeTarget());
    await assert.rejects(
      tracker.projects.reconcileProjectFields({}, {
        projectNumber: 3,
        declared: ["Status", ""],
      }),
      /declared\[\] entries must be non-empty strings/,
    );
  });
});
