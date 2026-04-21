// lib/trackers/linear.mjs
// Real Linear tracker backend. Uses Linear's GraphQL API via global
// fetch (Node >=20). No @linear/sdk dependency: respects the bundle's
// zero-runtime-deps discipline.
//
// Auth: LINEAR_API_KEY environment variable (passed as-is in the
// Authorization header; Linear expects the raw API key, not a Bearer
// prefix).
//
// Implemented namespaces:
//   issues.*  — full (createIssue, updateIssueStatus, comment,
//               relabelIssue, getIssue, listIssues)
//   labels.*  — full (reconcileLabels, relabelBulk)
//   review.*  — stub (Linear has no native PR concept)
//   projects.* — stub (Linear has no GitHub-style project board)

import {
  NotSupportedError,
  REVIEW_METHODS,
  TRACKER_NAMESPACES,
} from "./tracker.mjs";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const MAX_LABEL_PAGES = 10;
const MAX_LIST_PAGES = 10;

// ── GraphQL helper ──────────────────────────────────────────────────

async function defaultGraphql(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY environment variable is required for Linear tracker operations",
    );
  }
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API returned ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(
      `Linear GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return json.data;
}

// ── Lazy caches (per tracker instance) ──────────────────────────────

function createCaches() {
  return { teamId: null, workflowStates: null, labelMap: null };
}

async function resolveTeamId(gql, target, caches) {
  if (caches.teamId) return caches.teamId;
  const teamKey = target.team;
  if (!teamKey) {
    throw new Error(
      "Linear tracker requires target.team (team key, e.g. 'ENG')",
    );
  }
  const data = await gql(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes { id key name }
      }
    }`,
    { key: teamKey },
  );
  const team = data?.teams?.nodes?.[0];
  if (!team) throw new Error(`Linear team with key '${teamKey}' not found`);
  caches.teamId = team.id;
  return team.id;
}

async function resolveWorkflowStates(gql, target, caches) {
  if (caches.workflowStates) return caches.workflowStates;
  const teamId = await resolveTeamId(gql, target, caches);
  const data = await gql(
    `query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) {
        nodes { id name type }
      }
    }`,
    { teamId },
  );
  caches.workflowStates = data?.workflowStates?.nodes ?? [];
  return caches.workflowStates;
}

const STATUS_TYPE_MAP = {
  backlog: "backlog",
  ready: "unstarted",
  in_progress: "started",
  in_review: "started",
  done: "completed",
  cancelled: "canceled",
};

async function resolveStateId(gql, target, caches, statusName) {
  if (typeof statusName !== "string" || statusName.trim().length === 0) {
    throw new TypeError(
      "linear resolveStateId: statusName must be a non-empty string",
    );
  }
  const trimmed = statusName.trim();
  const states = await resolveWorkflowStates(gql, target, caches);
  const byName = states.find(
    (s) => s.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byName) return byName.id;
  const mappedType = STATUS_TYPE_MAP[trimmed.toLowerCase()];
  if (mappedType) {
    // Prefer a state whose name also contains the key hint (e.g. prefer
    // "In Review" over "In Progress" when both are type "started" and
    // the vocabulary key is "in_review").
    const candidates = states.filter((s) => s.type === mappedType);
    const hinted = candidates.find(
      (s) => s.name.toLowerCase().includes(trimmed.replace(/_/g, " ")),
    );
    const byType = hinted || candidates[0];
    if (byType) return byType.id;
  }
  const available = states.map((s) => `${s.name} (${s.type})`).join(", ");
  throw new Error(
    `Linear: no workflow state matching '${trimmed}' on team '${target.team}'. Available: ${available}`,
  );
}

// ── Label helpers ───────────────────────────────────────────────────

async function resolveLabelMap(gql, caches) {
  if (caches.labelMap) return caches.labelMap;
  const map = new Map();
  let cursor = null;
  let truncated = false;
  for (let page = 0; page < MAX_LABEL_PAGES; page++) {
    const data = await gql(
      `query($after: String) {
        issueLabels(first: 100, after: $after) {
          nodes { id name color }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor },
    );
    for (const label of data?.issueLabels?.nodes ?? []) {
      map.set(label.name.toLowerCase(), label);
    }
    if (!data?.issueLabels?.pageInfo?.hasNextPage) break;
    cursor = data.issueLabels.pageInfo.endCursor;
    if (page === MAX_LABEL_PAGES - 1) truncated = true;
  }
  if (truncated) {
    throw new Error(
      `Linear: workspace has more than ${MAX_LABEL_PAGES * 100} labels; label resolution was truncated. Contact maintainers to raise the page cap.`,
    );
  }
  caches.labelMap = map;
  return map;
}

async function resolveLabelIds(gql, caches, labelNames) {
  const map = await resolveLabelMap(gql, caches);
  const ids = [];
  const missing = [];
  for (const name of labelNames) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `linear resolveLabelIds: every label name must be a non-empty string; got ${JSON.stringify(name)}`,
      );
    }
    const label = map.get(name.trim().toLowerCase());
    if (label) ids.push(label.id);
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Linear: labels not found: ${missing.join(", ")}. Create them first via labels.reconcileLabels.`,
    );
  }
  return ids;
}

// ── issues.* ────────────────────────────────────────────────────────

async function linearCreateIssue(gql, target, caches, _ctx, payload) {
  let { title, body = "", labels = [] } = payload ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TypeError(
      "linear issues.createIssue: title must be a non-empty string",
    );
  }
  title = title.trim();
  if (typeof body !== "string") {
    throw new TypeError(
      "linear issues.createIssue: body must be a string when provided",
    );
  }
  if (!Array.isArray(labels)) {
    throw new TypeError(
      "linear issues.createIssue: labels must be an array of label names",
    );
  }
  if (payload?.templateName != null) {
    throw new Error(
      "linear issues.createIssue: templateName is not supported on the Linear backend; render the body before calling createIssue",
    );
  }
  labels = labels.map((l) => {
    if (typeof l !== "string" || l.trim().length === 0) {
      throw new TypeError(
        `linear issues.createIssue: every labels[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
      );
    }
    return l.trim();
  });
  const teamId = await resolveTeamId(gql, target, caches);

  // Dedupe: search open issues by exact title match (paginated)
  let dedupeCursor = null;
  const DEDUPE_MAX = 500;
  let dedupeScanned = 0;
  let match = null;
  while (dedupeScanned < DEDUPE_MAX) {
    const searchData = await gql(
      `query($teamId: String!, $first: Int!, $after: String) {
        issues(filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["completed", "canceled"] } } }, first: $first, after: $after) {
          nodes { id identifier title url }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { teamId, first: 100, after: dedupeCursor },
    );
    const nodes = searchData?.issues?.nodes ?? [];
    match = nodes.find((n) => n.title === title);
    if (match) break;
    dedupeScanned += nodes.length;
    if (!searchData?.issues?.pageInfo?.hasNextPage) break;
    dedupeCursor = searchData.issues.pageInfo.endCursor;
  }
  if (match) {
    return {
      id: match.id,
      identifier: match.identifier,
      url: match.url,
      existed: true,
    };
  }

  const input = { teamId, title, description: body || undefined };
  if (labels.length > 0) {
    input.labelIds = await resolveLabelIds(gql, caches, labels);
  }
  const data = await gql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }`,
    { input },
  );
  const issue = data?.issueCreate?.issue;
  if (!issue) {
    throw new Error("linear issues.createIssue: mutation returned no issue");
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    existed: false,
  };
}

async function linearUpdateIssueStatus(gql, target, caches, _ctx, payload) {
  const { issueId, status } = payload ?? {};
  if (!issueId) {
    throw new TypeError(
      "linear issues.updateIssueStatus: issueId is required",
    );
  }
  if (typeof status !== "string" || status.trim().length === 0) {
    throw new TypeError(
      "linear issues.updateIssueStatus: status must be a non-empty string",
    );
  }
  // Human gate: never set Done / completed
  const lower = status.trim().toLowerCase();
  if (lower === "done" || STATUS_TYPE_MAP[lower] === "completed") {
    throw new Error(
      "linear issues.updateIssueStatus: refusing to set Done; that is a human gate per rules/pr-workflow.md",
    );
  }
  const stateId = await resolveStateId(gql, target, caches, status);
  // Double-check the resolved state type (catches exact name matches
  // like "Completed" that bypass the vocabulary-key check above)
  const states = await resolveWorkflowStates(gql, target, caches);
  const resolved = states.find((s) => s.id === stateId);
  if (resolved?.type === "completed") {
    throw new Error(
      `linear issues.updateIssueStatus: refusing to set '${resolved.name}' (type: completed); that is a human gate per rules/pr-workflow.md`,
    );
  }

  // No-op check: fetch current state, skip if already matching
  const currentData = await gql(
    `query($id: String!) {
      issue(id: $id) { state { id } }
    }`,
    { id: issueId },
  );
  if (currentData?.issue?.state?.id === stateId) {
    return { id: issueId, identifier: null, state: null, noop: true };
  }

  const data = await gql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { id identifier state { name type } }
      }
    }`,
    { id: issueId, stateId },
  );
  const updated = data?.issueUpdate;
  if (!updated?.success || !updated?.issue?.id) {
    throw new Error(
      `linear issues.updateIssueStatus: mutation failed or returned no issue (success: ${updated?.success})`,
    );
  }
  return {
    id: updated.issue.id,
    identifier: updated.issue.identifier,
    state: updated.issue.state,
  };
}

async function linearComment(gql, _target, _caches, _ctx, payload) {
  const { issueId, body } = payload ?? {};
  if (!issueId) {
    throw new TypeError("linear issues.comment: issueId is required");
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new TypeError(
      "linear issues.comment: body must be a non-empty string",
    );
  }
  const data = await gql(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id body url }
      }
    }`,
    { issueId, body },
  );
  const result = data?.commentCreate;
  if (!result?.success || !result?.comment?.id) {
    throw new Error(
      `linear issues.comment: mutation failed (success: ${result?.success})`,
    );
  }
  return { id: result.comment.id, url: result.comment.url };
}

async function linearRelabelIssue(gql, _target, caches, _ctx, payload) {
  const { issueId, add = [], remove = [] } = payload ?? {};
  if (!issueId) {
    throw new TypeError("linear issues.relabelIssue: issueId is required");
  }
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    throw new TypeError(
      "linear issues.relabelIssue: add and remove must be arrays of label names",
    );
  }
  for (const name of [...add, ...remove]) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `linear issues.relabelIssue: every add/remove entry must be a non-empty string; got ${JSON.stringify(name)}`,
      );
    }
  }
  if (add.length === 0 && remove.length === 0) {
    return { id: issueId, labels: [], noop: true };
  }
  // Fetch current labels on the issue for delta semantics
  const currentData = await gql(
    `query($id: String!) {
      issue(id: $id) { labels { nodes { id name } } }
    }`,
    { id: issueId },
  );
  const currentIds = new Set(
    (currentData?.issue?.labels?.nodes ?? []).map((l) => l.id),
  );

  // Resolve add/remove to IDs; throw on unknown names (matches GitHub)
  const labelMap = await resolveLabelMap(gql, caches);
  const missingAdd = [];
  for (const name of add) {
    const trimmed = name.trim().toLowerCase();
    const label = labelMap.get(trimmed);
    if (label) currentIds.add(label.id);
    else missingAdd.push(name);
  }
  if (missingAdd.length > 0) {
    throw new Error(
      `linear issues.relabelIssue: labels not found for add: ${missingAdd.join(", ")}`,
    );
  }
  for (const name of remove) {
    const trimmed = name.trim().toLowerCase();
    const label = labelMap.get(trimmed);
    if (label) currentIds.delete(label.id);
  }

  const labelIds = [...currentIds];
  const data = await gql(
    `mutation($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) {
        success
        issue { id identifier labels { nodes { id name } } }
      }
    }`,
    { id: issueId, labelIds },
  );
  const updated = data?.issueUpdate;
  if (!updated?.success || !updated?.issue?.id) {
    throw new Error(
      `linear issues.relabelIssue: mutation failed (success: ${updated?.success})`,
    );
  }
  return {
    id: updated.issue.id,
    labels: updated.issue.labels?.nodes ?? [],
  };
}

async function linearGetIssue(gql, _target, _caches, _ctx, payload) {
  const { issueId } = payload ?? {};
  if (!issueId) {
    throw new TypeError("linear issues.getIssue: issueId is required");
  }
  const data = await gql(
    `query($id: String!) {
      issue(id: $id) {
        id identifier title description url
        state { id name type }
        labels { nodes { id name } }
        assignee { id name }
        createdAt updatedAt
      }
    }`,
    { id: issueId },
  );
  const issue = data?.issue;
  if (!issue) {
    throw new Error(`linear issues.getIssue: issue '${issueId}' not found`);
  }
  return issue;
}

async function linearListIssues(gql, target, caches, _ctx, payload = {}) {
  const { state, labels: filterLabels, first: rawFirst = 50 } = payload;
  const first = typeof rawFirst === "number" && rawFirst > 0
    ? Math.min(Math.floor(rawFirst), 1000)
    : 50;
  const teamId = await resolveTeamId(gql, target, caches);
  const filter = { team: { id: { eq: teamId } } };
  if (state) {
    const stateId = await resolveStateId(gql, target, caches, state);
    filter.state = { id: { eq: stateId } };
  }
  if (filterLabels != null) {
    if (!Array.isArray(filterLabels)) {
      throw new TypeError(
        "linear issues.listIssues: labels filter must be an array of label names",
      );
    }
    if (filterLabels.length > 0) {
      const labelIds = await resolveLabelIds(gql, caches, filterLabels);
      filter.labels = { id: { in: labelIds } };
    }
  }
  const results = [];
  let cursor = null;
  const pageSize = Math.min(first, 100);
  let truncated = false;
  for (let page = 0; page < MAX_LIST_PAGES && results.length < first; page++) {
    const data = await gql(
      `query($filter: IssueFilter!, $first: Int!, $after: String) {
        issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
          nodes {
            id identifier title url
            state { name type }
            labels { nodes { id name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, first: pageSize, after: cursor },
    );
    for (const issue of data?.issues?.nodes ?? []) {
      results.push(issue);
    }
    if (!data?.issues?.pageInfo?.hasNextPage) break;
    cursor = data.issues.pageInfo.endCursor;
    if (page === MAX_LIST_PAGES - 1 && results.length < first) {
      truncated = true;
    }
  }
  if (truncated) {
    const out = results.slice(0, first);
    out.truncated = true;
    return out;
  }
  return results.slice(0, first);
}

// ── labels.* ────────────────────────────────────────────────────────

async function linearReconcileLabels(gql, _target, caches, _ctx, payload) {
  // Accept both { desired: [...] } and { taxonomy: [...], apply: bool }
  const raw = payload ?? {};
  const taxonomy = raw.taxonomy ?? raw.desired ?? [];
  const apply = raw.apply === true;
  if (!Array.isArray(taxonomy)) {
    throw new TypeError(
      "linear labels.reconcileLabels: taxonomy (or desired) must be an array",
    );
  }
  const map = await resolveLabelMap(gql, caches);
  const created = [];
  const updated = [];
  const unchanged = [];
  for (const want of taxonomy) {
    const name = typeof want === "string" ? want : want.name;
    const color = typeof want === "string" ? undefined : want.color;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `linear labels.reconcileLabels: each taxonomy entry must have a non-empty string name; got ${JSON.stringify(want)}`,
      );
    }
    const trimmedName = name.trim();
    if (color != null && (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))) {
      throw new TypeError(
        `linear labels.reconcileLabels: color must be a hex string like '#ff0000'; got ${JSON.stringify(color)}`,
      );
    }
    const existing = map.get(trimmedName.toLowerCase());
    if (existing) {
      if (color && existing.color !== color) {
        if (apply) {
          await gql(
            `mutation($id: String!, $input: IssueLabelUpdateInput!) {
              issueLabelUpdate(id: $id, input: $input) {
                success issueLabel { id name color }
              }
            }`,
            { id: existing.id, input: { color } },
          );
          existing.color = color;
        }
        updated.push(trimmedName);
      } else {
        unchanged.push(trimmedName);
      }
    } else {
      if (apply) {
        const data = await gql(
          `mutation($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              success issueLabel { id name color }
            }
          }`,
          { input: { name: trimmedName, color: color || "#888888" } },
        );
        const label = data?.issueLabelCreate?.issueLabel;
        if (label) map.set(label.name.toLowerCase(), label);
      }
      created.push(trimmedName);
    }
  }
  // Return shape aligned with GitHub's reconcileLabels contract
  const plan = [
    ...created.map((n) => ({ action: "create", name: n })),
    ...updated.map((n) => ({ action: "update", name: n })),
    ...unchanged.map((n) => ({ action: "unchanged", name: n })),
  ];
  return { mode: apply ? "applied" : "dry-run", plan };
}

async function linearRelabelBulk(gql, _target, caches, _ctx, payload) {
  const raw = payload ?? {};
  const plan = raw.plan ?? [];
  const apply = raw.apply === true;
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new TypeError(
      "linear labels.relabelBulk: plan must be a non-empty array of {from, to}",
    );
  }
  // On Linear, labels are workspace-scoped, so a "rename" is done by
  // updating the label itself (not per-issue). Each {from, to} entry
  // renames the label at the workspace level.
  const labelMap = await resolveLabelMap(gql, caches);
  const results = [];
  for (const entry of plan) {
    const from = entry?.from;
    const to = entry?.to;
    if (!from || !to) {
      results.push({ from, to, success: false, error: "missing from or to" });
      continue;
    }
    const existing = labelMap.get(from.trim().toLowerCase());
    if (!existing) {
      results.push({ from, to, success: false, error: `label '${from}' not found` });
      continue;
    }
    if (!apply) {
      results.push({ from, to, success: true, action: "would-rename" });
      continue;
    }
    try {
      const data = await gql(
        `mutation($id: String!, $input: IssueLabelUpdateInput!) {
          issueLabelUpdate(id: $id, input: $input) {
            success issueLabel { id name }
          }
        }`,
        { id: existing.id, input: { name: to.trim() } },
      );
      const renamed = data?.issueLabelUpdate?.issueLabel;
      if (renamed) {
        labelMap.delete(from.trim().toLowerCase());
        labelMap.set(renamed.name.toLowerCase(), renamed);
      }
      results.push({ from, to, success: true, action: "renamed" });
    } catch (err) {
      results.push({ from, to, success: false, error: err?.message ?? String(err) });
    }
  }
  // Invalidate label cache since renames changed the map
  caches.labelMap = null;
  return { mode: apply ? "applied" : "dry-run", results };
}

// ── review.* + projects.* stubs ─────────────────────────────────────

function makeReviewStub() {
  const stub = {};
  for (const op of REVIEW_METHODS) {
    stub[op] = async () => {
      throw new NotSupportedError(
        `Linear has no native PR review concept. Configure a separate tracker kind for code review via workflow.external_review.provider: "github".`,
        { kind: "linear", op, namespace: "review" },
      );
    };
  }
  return stub;
}

function makeProjectsStub() {
  const stub = {};
  for (const op of TRACKER_NAMESPACES.projects) {
    stub[op] = async () => {
      throw new NotSupportedError(
        `Linear has no GitHub-style project board. Use issues.listIssues with filters instead.`,
        { kind: "linear", op, namespace: "projects" },
      );
    };
  }
  return stub;
}

// ── Factory ─────────────────────────────────────────────────────────

export function makeLinearTracker(target = {}, { graphql = null } = {}) {
  const gql = graphql || defaultGraphql;
  const caches = createCaches();

  const issues = {
    createIssue: (ctx, payload) =>
      linearCreateIssue(gql, target, caches, ctx, payload),
    updateIssueStatus: (ctx, payload) =>
      linearUpdateIssueStatus(gql, target, caches, ctx, payload),
    comment: (ctx, payload) =>
      linearComment(gql, target, caches, ctx, payload),
    relabelIssue: (ctx, payload) =>
      linearRelabelIssue(gql, target, caches, ctx, payload),
    getIssue: (ctx, payload) =>
      linearGetIssue(gql, target, caches, ctx, payload),
    listIssues: (ctx, payload) =>
      linearListIssues(gql, target, caches, ctx, payload),
  };

  const labels = {
    reconcileLabels: (ctx, payload) =>
      linearReconcileLabels(gql, target, caches, ctx, payload),
    relabelBulk: (ctx, payload) =>
      linearRelabelBulk(gql, target, caches, ctx, payload),
  };

  const missingIssues = TRACKER_NAMESPACES.issues.filter(
    (m) => typeof issues[m] !== "function",
  );
  if (missingIssues.length > 0) {
    throw new Error(
      `makeLinearTracker: missing issues methods [${missingIssues.join(", ")}]`,
    );
  }
  const missingLabels = TRACKER_NAMESPACES.labels.filter(
    (m) => typeof labels[m] !== "function",
  );
  if (missingLabels.length > 0) {
    throw new Error(
      `makeLinearTracker: missing labels methods [${missingLabels.join(", ")}]`,
    );
  }

  return {
    kind: "linear",
    target,
    review: makeReviewStub(),
    issues,
    labels,
    projects: makeProjectsStub(),
  };
}
