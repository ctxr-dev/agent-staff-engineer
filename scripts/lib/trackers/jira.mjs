// lib/trackers/jira.mjs
// Real Jira Cloud tracker backend. Uses the Jira REST API v3 via
// global fetch (Node >=20). No jira-cli dependency.
//
// Auth: basic auth over HTTPS with the user's Atlassian email as
// username and an API token as password. Set JIRA_EMAIL + JIRA_API_TOKEN
// in the environment. This matches Atlassian's 2025 guidance; Jira
// Cloud no longer accepts the legacy `Authorization: Bearer ...` for
// user tokens on the v3 REST surface.
//
// Implemented namespaces:
//   issues.*   — full (createIssue, updateIssueStatus, comment,
//                relabelIssue, getIssue, listIssues)
//   labels.*   — partial (reconcileLabels is advisory, Jira labels are
//                uncontrolled strings; relabelBulk performs an
//                iterate-and-swap across issues matching the `from`
//                label)
//   review.*   — stub (Jira has no PR surface)
//   projects.* — stub (Jira's custom-fields model is instance-specific
//                and does not map to the Tracker.projects contract)
//
// Rich-text payloads (issue description, comment body) use Atlassian
// Document Format (ADF); see jira-adf.mjs for the markdown-to-ADF
// converter.

import {
  NotSupportedError,
  REVIEW_METHODS,
  TRACKER_NAMESPACES,
} from "./tracker.mjs";
import { markdownToAdf, plainTextToAdf } from "./jira-adf.mjs";

const MAX_PAGES = 10;
const MAX_PAGE_SIZE = 100;

// Maps the agent's vocabulary keys to Jira's statusCategory keys.
// Used exclusively to enforce the "never move to Done" human gate on
// the input side (first tier): if the caller asks for `done` /
// `cancelled`, refuse before touching the API. The second-tier gate
// (on the transition's destination `statusCategory.key`) catches the
// opposite shape: a workflow whose literal state name isn't "Done" but
// still lives in the done category (e.g. "Shipped", "Released").
const STATUS_CATEGORY_MAP = {
  backlog: "new",
  ready: "new",
  in_progress: "indeterminate",
  in_review: "indeterminate",
  done: "done",
  cancelled: "done",
};

// ── REST helper ─────────────────────────────────────────────────────

/**
 * Normalise a bare Jira site hostname to an https URL. The
 * ops.config schema records `site` as a bare hostname (e.g.
 * `acme.atlassian.net`); `new URL` refuses a bare host as a base, so
 * we prefix `https://` when a scheme is missing. Env override
 * `JIRA_BASE_URL` may already include a scheme, in which case this is
 * a no-op.
 */
export function normalizeJiraBase(raw) {
  const s = String(raw).trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

async function defaultRest(
  method,
  path,
  { body = null, query = {}, baseUrl: overrideBase = null } = {},
) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error(
      "JIRA_EMAIL and JIRA_API_TOKEN environment variables are both required for Jira tracker operations",
    );
  }
  const rawBase = overrideBase || process.env.JIRA_BASE_URL;
  if (!rawBase) {
    throw new Error(
      "Jira tracker requires target.site or JIRA_BASE_URL env (e.g. 'acme.atlassian.net')",
    );
  }
  const baseUrl = normalizeJiraBase(rawBase);
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const opts = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(url.toString(), opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Jira API ${method} ${path} returned ${res.status}: ${text}`,
    );
  }
  if (res.status === 204) return null;
  const ct = res.headers?.get?.("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    return text || null;
  }
  return res.json();
}

// ── Caches ──────────────────────────────────────────────────────────

function createCaches() {
  return {
    projectId: null,
    issueTypes: null,
  };
}

// ── Project + issue-type resolution ─────────────────────────────────

async function resolveProjectId(rest, target, caches) {
  if (caches.projectId) return caches.projectId;
  const key = target.project;
  if (!key) {
    throw new Error("Jira tracker requires target.project (project key)");
  }
  const data = await rest("GET", `/rest/api/3/project/${encodeURIComponent(key)}`);
  if (!data?.id) {
    throw new Error(`Jira: project with key '${key}' not found`);
  }
  caches.projectId = String(data.id);
  return caches.projectId;
}

async function resolveDefaultIssueTypeId(rest, target, caches) {
  if (caches.issueTypes == null) {
    const data = await rest(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(target.project)}`,
    );
    caches.issueTypes = Array.isArray(data?.issueTypes) ? data.issueTypes : [];
  }
  // Prefer "Task" as the standard issue type; fall back to the first
  // non-subtask on the project. Subtasks are refused because they
  // require a parent and never represent a dev issue at this level.
  const nonSub = caches.issueTypes.filter((t) => !t.subtask);
  const task = nonSub.find(
    (t) => String(t.name).toLowerCase() === "task",
  );
  const chosen = task || nonSub[0];
  if (!chosen?.id) {
    throw new Error(
      `Jira: project '${target.project}' has no non-subtask issue types available`,
    );
  }
  return String(chosen.id);
}

// ── issues.createIssue ──────────────────────────────────────────────

async function jiraCreateIssue(rest, target, caches, _ctx, payload) {
  const {
    title,
    body = "",
    labels = [],
    templateName,
    issueType,
  } = payload ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TypeError(
      "jira issues.createIssue: title must be a non-empty string",
    );
  }
  if (typeof body !== "string") {
    throw new TypeError(
      "jira issues.createIssue: body must be a string when provided",
    );
  }
  if (!Array.isArray(labels)) {
    throw new TypeError(
      "jira issues.createIssue: labels must be an array of label names",
    );
  }
  if (templateName != null) {
    throw new Error(
      "jira issues.createIssue: templateName is not supported on the Jira backend; render the body to markdown before calling createIssue",
    );
  }
  const cleanedLabels = labels.map((l) => {
    if (typeof l !== "string" || l.trim().length === 0) {
      throw new TypeError(
        `jira issues.createIssue: every labels[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
      );
    }
    // Jira labels cannot contain spaces; it silently collapses them,
    // which causes a mismatch between the value the agent thinks it
    // wrote and what Jira stored. Reject at the boundary with a
    // pointed message.
    const trimmed = l.trim();
    if (/\s/.test(trimmed)) {
      throw new TypeError(
        `jira issues.createIssue: Jira labels cannot contain whitespace; got ${JSON.stringify(l)}`,
      );
    }
    return trimmed;
  });
  const trimmedTitle = title.trim();
  const projectId = await resolveProjectId(rest, target, caches);

  // Dedupe: JQL on exact title match within the open-state set. Jira
  // does not treat `summary = "..."` as an exact match for long
  // summaries (it tokenises), so additionally verify summary equality
  // on the first page of results.
  const dedupeJql = `project = "${target.project}" AND statusCategory != Done AND summary ~ "\\"${escapeJqlString(trimmedTitle)}\\""`;
  const dedupeData = await rest("POST", "/rest/api/3/search/jql", {
    body: {
      jql: dedupeJql,
      maxResults: 50,
      fields: ["summary", "status"],
    },
  });
  const dedupeHit = (dedupeData?.issues ?? []).find(
    (i) => i.fields?.summary === trimmedTitle,
  );
  if (dedupeHit) {
    return {
      id: dedupeHit.id,
      key: dedupeHit.key,
      url: `${normalizeJiraBase(target.site)}/browse/${dedupeHit.key}`,
      existed: true,
    };
  }

  const issueTypeId = issueType
    ? String(issueType)
    : await resolveDefaultIssueTypeId(rest, target, caches);
  const fields = {
    project: { id: projectId },
    summary: trimmedTitle,
    issuetype: { id: issueTypeId },
  };
  if (body.trim().length > 0) {
    fields.description = markdownToAdf(body);
  }
  if (cleanedLabels.length > 0) {
    fields.labels = cleanedLabels;
  }
  const created = await rest("POST", "/rest/api/3/issue", {
    body: { fields },
  });
  if (!created?.key) {
    throw new Error(
      "jira issues.createIssue: API response missing key (unexpected shape)",
    );
  }
  return {
    id: String(created.id),
    key: created.key,
    url: `${normalizeJiraBase(target.site)}/browse/${created.key}`,
    existed: false,
  };
}

function escapeJqlString(s) {
  // JQL inside double-quoted literal: backslash-escape backslashes
  // first, then quotes. Callers still wrap the result in literal
  // `\"..\"` so the leading/trailing double-quote is safe.
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── issues.updateIssueStatus ────────────────────────────────────────

async function jiraUpdateIssueStatus(rest, target, _caches, _ctx, payload) {
  const { issueId, status } = payload ?? {};
  if (!issueId) {
    throw new TypeError("jira issues.updateIssueStatus: issueId is required");
  }
  if (typeof status !== "string" || status.trim().length === 0) {
    throw new TypeError(
      "jira issues.updateIssueStatus: status must be a non-empty string",
    );
  }
  const trimmedStatus = status.trim();
  const lower = trimmedStatus.toLowerCase();

  // Human gate A: refuse if the vocabulary key maps to the `done`
  // category.
  if (STATUS_CATEGORY_MAP[lower] === "done") {
    throw new Error(
      "jira issues.updateIssueStatus: refusing to set Done/cancelled; that is a human gate per rules/pr-workflow.md",
    );
  }

  // Fetch current status so we can no-op.
  const current = await rest(
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueId)}`,
    { query: { fields: "status" } },
  );
  const currentName = current?.fields?.status?.name;
  const currentKey = current?.fields?.status?.statusCategory?.key;
  if (currentName && currentName.toLowerCase() === lower) {
    return { id: String(current.id), key: current.key, status: currentName, noop: true };
  }

  // Discover available transitions for the issue's current state.
  const transData = await rest(
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`,
  );
  const transitions = Array.isArray(transData?.transitions)
    ? transData.transitions
    : [];
  if (transitions.length === 0) {
    throw new Error(
      `jira issues.updateIssueStatus: issue ${issueId} has no transitions available (workflow may require a different user or permission)`,
    );
  }
  const match = pickTransition(transitions, trimmedStatus);
  if (!match) {
    const available = transitions
      .map((t) => `${t.name} -> ${t.to?.name ?? "?"}`)
      .join(", ");
    throw new Error(
      `jira issues.updateIssueStatus: no transition to '${trimmedStatus}' from '${currentName ?? "?"}' on issue ${issueId}. Available: ${available}`,
    );
  }
  // Human gate B: the destination statusCategory resolves to "done".
  // Catches renamed workflows where the literal name isn't "Done".
  if (match.to?.statusCategory?.key === "done") {
    throw new Error(
      `jira issues.updateIssueStatus: refusing transition to '${match.to?.name}' (statusCategory: done); that is a human gate per rules/pr-workflow.md`,
    );
  }
  await rest(
    "POST",
    `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`,
    { body: { transition: { id: match.id } } },
  );
  return {
    id: String(current?.id ?? issueId),
    key: current?.key ?? null,
    status: match.to?.name ?? trimmedStatus,
    previousStatus: currentName ?? null,
    previousStatusCategory: currentKey ?? null,
    transitionId: match.id,
  };
}

function pickTransition(transitions, requestedName) {
  const lower = requestedName.toLowerCase();
  // Prefer a transition whose destination name matches; fall back to
  // a transition whose own name matches. This handles both shapes
  // seen in the wild: workflows where the transition is named after
  // the target ("In Review") and workflows where the transition is
  // an action ("Start review") that moves to a state.
  return (
    transitions.find((t) => t.to?.name?.toLowerCase() === lower) ||
    transitions.find((t) => t.name?.toLowerCase() === lower) ||
    null
  );
}

// ── issues.comment ──────────────────────────────────────────────────

async function jiraComment(rest, _target, _caches, _ctx, payload) {
  const { issueId, body } = payload ?? {};
  if (!issueId) {
    throw new TypeError("jira issues.comment: issueId is required");
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new TypeError(
      "jira issues.comment: body must be a non-empty string",
    );
  }
  const adf = /[*_`#>\-[\]]/.test(body) ? markdownToAdf(body) : plainTextToAdf(body);
  const created = await rest(
    "POST",
    `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`,
    { body: { body: adf } },
  );
  if (!created?.id) {
    throw new Error(
      "jira issues.comment: API response missing id (unexpected shape)",
    );
  }
  return { id: String(created.id), created: created.created ?? null };
}

// ── issues.relabelIssue ─────────────────────────────────────────────

async function jiraRelabelIssue(rest, _target, _caches, _ctx, payload) {
  const { issueId, add = [], remove = [] } = payload ?? {};
  if (!issueId) {
    throw new TypeError("jira issues.relabelIssue: issueId is required");
  }
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    throw new TypeError(
      "jira issues.relabelIssue: add and remove must be arrays of label names",
    );
  }
  for (const name of [...add, ...remove]) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `jira issues.relabelIssue: every label name must be a non-empty string; got ${JSON.stringify(name)}`,
      );
    }
    if (/\s/.test(name.trim())) {
      throw new TypeError(
        `jira issues.relabelIssue: Jira labels cannot contain whitespace; got ${JSON.stringify(name)}`,
      );
    }
  }
  const addSet = new Set(add.map((n) => n.trim().toLowerCase()));
  const removeSet = new Set(remove.map((n) => n.trim().toLowerCase()));
  const overlap = [...addSet].filter((n) => removeSet.has(n));
  if (overlap.length > 0) {
    throw new Error(
      `jira issues.relabelIssue: labels appear in both add and remove: ${overlap.join(", ")}`,
    );
  }
  if (add.length === 0 && remove.length === 0) {
    return { id: null, key: String(issueId), labels: [], noop: true };
  }
  // Delta semantics: fetch current labels, compute desired set, skip
  // the PUT when the delta produces no change (matches github/linear).
  const current = await rest(
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueId)}`,
    { query: { fields: "labels" } },
  );
  const currentLabels = Array.isArray(current?.fields?.labels)
    ? current.fields.labels
    : [];
  const currentLower = new Set(currentLabels.map((l) => l.toLowerCase()));
  const willAdd = add
    .map((n) => n.trim())
    .filter((n) => !currentLower.has(n.toLowerCase()));
  const willRemove = remove
    .map((n) => n.trim())
    .filter((n) => currentLower.has(n.toLowerCase()));
  if (willAdd.length === 0 && willRemove.length === 0) {
    return {
      id: String(current?.id ?? null),
      key: String(current?.key ?? issueId),
      labels: currentLabels,
      noop: true,
    };
  }
  const updateOps = [];
  for (const name of willAdd) updateOps.push({ add: name });
  for (const name of willRemove) updateOps.push({ remove: name });
  await rest("PUT", `/rest/api/3/issue/${encodeURIComponent(issueId)}`, {
    body: { update: { labels: updateOps } },
  });
  const afterLower = new Set(currentLower);
  for (const name of willAdd) afterLower.add(name.toLowerCase());
  for (const name of willRemove) afterLower.delete(name.toLowerCase());
  // Preserve original casing from currentLabels for names that were
  // neither added nor removed; for new adds use the trimmed input.
  const keep = currentLabels.filter((l) => afterLower.has(l.toLowerCase()));
  const adds = willAdd.filter((l) => !keep.some((k) => k.toLowerCase() === l.toLowerCase()));
  return {
    id: String(current?.id ?? null),
    key: String(current?.key ?? issueId),
    labels: [...keep, ...adds],
  };
}

// ── issues.getIssue ─────────────────────────────────────────────────

async function jiraGetIssue(rest, _target, _caches, _ctx, payload) {
  const { issueId, fields } = payload ?? {};
  if (!issueId) {
    throw new TypeError("jira issues.getIssue: issueId is required");
  }
  const query = {};
  if (Array.isArray(fields) && fields.length > 0) {
    for (const f of fields) {
      if (typeof f !== "string" || f.trim().length === 0) {
        throw new TypeError(
          `jira issues.getIssue: every fields[] entry must be a non-empty string; got ${JSON.stringify(f)}`,
        );
      }
    }
    query.fields = fields.map((f) => f.trim()).join(",");
  }
  const issue = await rest(
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueId)}`,
    { query },
  );
  if (!issue?.key) {
    throw new Error(`jira issues.getIssue: issue ${issueId} not found`);
  }
  return issue;
}

// ── issues.listIssues ───────────────────────────────────────────────

async function jiraListIssues(rest, target, caches, _ctx, payload = {}) {
  const { state, labels: filterLabels, first, limit } = payload;
  if (first != null && (typeof first !== "number" || !Number.isInteger(first) || first <= 0)) {
    throw new TypeError(
      `jira issues.listIssues: first must be a positive integer; got ${JSON.stringify(first)}`,
    );
  }
  if (limit != null && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
    throw new TypeError(
      `jira issues.listIssues: limit must be a positive integer; got ${JSON.stringify(limit)}`,
    );
  }
  if (state != null && typeof state !== "string") {
    throw new TypeError("jira issues.listIssues: state must be a string");
  }
  if (filterLabels != null && !Array.isArray(filterLabels)) {
    throw new TypeError(
      "jira issues.listIssues: labels must be an array of label names",
    );
  }
  if (Array.isArray(filterLabels)) {
    for (const name of filterLabels) {
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new TypeError(
          `jira issues.listIssues: every labels[] entry must be a non-empty string; got ${JSON.stringify(name)}`,
        );
      }
      // Jira labels cannot contain whitespace (the server silently
      // collapses them), so a whitespace-bearing filter would either
      // match nothing or match the wrong thing. Reject at the boundary
      // for consistency with createIssue / relabelIssue / reconcileLabels.
      if (/\s/.test(name.trim())) {
        throw new TypeError(
          `jira issues.listIssues: Jira labels cannot contain whitespace; got ${JSON.stringify(name)}`,
        );
      }
    }
  }
  await resolveProjectId(rest, target, caches); // validates project

  const cap = Math.min(first ?? limit ?? 50, MAX_PAGES * MAX_PAGE_SIZE);
  const jqlParts = [`project = "${target.project}"`];
  if (state != null) {
    const lower = state.trim().toLowerCase();
    if (lower === "done" || lower === "closed") {
      jqlParts.push("statusCategory = Done");
    } else {
      jqlParts.push("statusCategory != Done");
    }
  } else {
    jqlParts.push("statusCategory != Done");
  }
  if (Array.isArray(filterLabels) && filterLabels.length > 0) {
    const list = filterLabels
      .map((l) => `"${escapeJqlString(l.trim())}"`)
      .join(", ");
    jqlParts.push(`labels in (${list})`);
  }
  jqlParts.push("order by created ASC");
  const jql = jqlParts.join(" AND ").replace(/ AND order by/, " order by");

  const results = [];
  let nextPageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const perPage = Math.min(MAX_PAGE_SIZE, cap - results.length);
    if (perPage <= 0) break;
    const body = {
      jql,
      maxResults: perPage,
      fields: ["summary", "status", "labels", "assignee", "created", "updated"],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await rest("POST", "/rest/api/3/search/jql", { body });
    const batch = Array.isArray(data?.issues) ? data.issues : [];
    for (const issue of batch) {
      results.push(issue);
      if (results.length >= cap) break;
    }
    if (results.length >= cap) break;
    if (!data?.nextPageToken) break;
    nextPageToken = data.nextPageToken;
    // Safety probe at the MAX_PAGES boundary: the loop guard already
    // refuses to make a (MAX_PAGES + 1)th call, so truncation is
    // signalled by the caller's view of the array length vs. the
    // total if the caller cares. Parity with other backends: flip the
    // `truncated` sentinel when we hit the hard cap AND the API still
    // reports a next page.
    if (page === MAX_PAGES - 1 && nextPageToken) {
      const out = results.slice(0, cap);
      out.truncated = true;
      return out;
    }
  }
  return results.slice(0, cap);
}

// ── labels.reconcileLabels ──────────────────────────────────────────

async function jiraReconcileLabels(rest, target, caches, _ctx, payload) {
  const raw = payload ?? {};
  const taxonomy = raw.taxonomy ?? raw.desired ?? [];
  if (raw.apply != null && typeof raw.apply !== "boolean") {
    throw new TypeError(
      `jira labels.reconcileLabels: apply must be a boolean; got ${JSON.stringify(raw.apply)}`,
    );
  }
  if (raw.allowDeprecate != null && typeof raw.allowDeprecate !== "boolean") {
    throw new TypeError(
      `jira labels.reconcileLabels: allowDeprecate must be a boolean; got ${JSON.stringify(raw.allowDeprecate)}`,
    );
  }
  if (!Array.isArray(taxonomy)) {
    throw new TypeError(
      "jira labels.reconcileLabels: taxonomy must be an array",
    );
  }
  const apply = raw.apply === true;
  const allowDeprecate = raw.allowDeprecate === true;
  const desired = [];
  const seen = new Set();
  for (const want of taxonomy) {
    if (want == null || (typeof want !== "string" && typeof want !== "object")) {
      throw new TypeError(
        `jira labels.reconcileLabels: each entry must be a string or {name}; got ${JSON.stringify(want)}`,
      );
    }
    const name = typeof want === "string" ? want : want.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `jira labels.reconcileLabels: name must be a non-empty string; got ${JSON.stringify(want)}`,
      );
    }
    const trimmed = name.trim();
    if (/\s/.test(trimmed)) {
      throw new TypeError(
        `jira labels.reconcileLabels: Jira labels cannot contain whitespace; got ${JSON.stringify(name)}`,
      );
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    desired.push(trimmed);
  }
  await resolveProjectId(rest, target, caches); // validates project

  // Discover labels currently in use on the project. Jira has no
  // "project-scoped label registry"; labels exist implicitly when an
  // issue carries them. Use JQL to enumerate the set. The loop is
  // bounded by MAX_PAGES; refuse to produce a silent undercount when
  // the API still reports a nextPageToken after the hard cap, because
  // a truncated sample would drive `reconcileLabels` into suggesting
  // a spurious "create" for a label that is actually already in use.
  const usedLower = new Set();
  let cursor = null;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      jql: `project = "${target.project}"`,
      maxResults: MAX_PAGE_SIZE,
      fields: ["labels"],
    };
    if (cursor) body.nextPageToken = cursor;
    const data = await rest("POST", "/rest/api/3/search/jql", { body });
    for (const issue of data?.issues ?? []) {
      for (const l of issue.fields?.labels ?? []) {
        if (typeof l === "string") usedLower.add(l.toLowerCase());
      }
    }
    if (!data?.nextPageToken) break;
    cursor = data.nextPageToken;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  if (truncated) {
    throw new Error(
      `Jira labels.reconcileLabels: project '${target.project}' has more than ${MAX_PAGES * MAX_PAGE_SIZE} issues; the in-use-labels scan was truncated and the plan would be unreliable. Contact maintainers to raise the page cap.`,
    );
  }

  const plan = [];
  for (const name of desired) {
    plan.push({
      action: usedLower.has(name.toLowerCase()) ? "unchanged" : "create",
      name,
      // Jira labels have no color/description attached to them; the
      // "create" action is advisory. The label exists implicitly the
      // first time an issue uses it, which happens via relabelIssue /
      // createIssue + labels[], so no API call is made here.
      note:
        !usedLower.has(name.toLowerCase()) && apply
          ? "Jira labels materialise when first applied to an issue; no create API call is needed"
          : undefined,
    });
  }
  if (allowDeprecate) {
    const desiredLower = new Set(desired.map((n) => n.toLowerCase()));
    for (const lower of usedLower) {
      if (!desiredLower.has(lower)) {
        plan.push({
          action: "deprecate",
          name: lower,
          note: apply
            ? "Deprecation on Jira requires an issue-by-issue label sweep; use labels.relabelBulk with a {from, to: ''} migration plan to clear the label"
            : undefined,
        });
      }
    }
  }
  const result = { mode: apply ? "applied" : "dry-run", plan };
  if (apply) result.applied = true;
  return result;
}

// ── labels.relabelBulk ──────────────────────────────────────────────

async function jiraRelabelBulk(rest, target, caches, ctx, payload) {
  const raw = payload ?? {};
  if (raw.apply != null && typeof raw.apply !== "boolean") {
    throw new TypeError(
      `jira labels.relabelBulk: apply must be a boolean; got ${JSON.stringify(raw.apply)}`,
    );
  }
  const plan = raw.plan ?? [];
  const apply = raw.apply === true;
  if (!Array.isArray(plan)) {
    throw new TypeError(
      "jira labels.relabelBulk: plan must be an array of {from, to}",
    );
  }
  if (plan.length === 0) {
    return { mode: apply ? "applied" : "dry-run", results: [] };
  }
  await resolveProjectId(rest, target, caches); // validates project

  const results = [];
  for (const entry of plan) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      results.push({ from: null, to: null, success: false, error: "invalid entry" });
      continue;
    }
    const from = entry.from;
    const to = entry.to;
    if (typeof from !== "string" || from.trim().length === 0) {
      results.push({ from: from ?? null, to: to ?? null, success: false, error: "from must be a non-empty string" });
      continue;
    }
    if (typeof to !== "string") {
      results.push({ from, to: to ?? null, success: false, error: "to must be a string (use '' to delete the label)" });
      continue;
    }
    const fromTrim = from.trim();
    const toTrim = to.trim();
    if (/\s/.test(fromTrim) || (toTrim.length > 0 && /\s/.test(toTrim))) {
      results.push({ from, to, success: false, error: "Jira labels cannot contain whitespace" });
      continue;
    }
    if (fromTrim.toLowerCase() === toTrim.toLowerCase()) {
      results.push({ from, to, success: true, action: "no-op" });
      continue;
    }
    if (!apply) {
      results.push({ from, to, success: true, action: toTrim.length === 0 ? "would-delete" : "would-rename" });
      continue;
    }
    try {
      const swept = await sweepLabel(rest, target, caches, ctx, fromTrim, toTrim);
      results.push({
        from,
        to,
        success: true,
        action: toTrim.length === 0 ? "deleted" : "renamed",
        issuesTouched: swept,
      });
    } catch (err) {
      results.push({ from, to, success: false, error: err?.message ?? String(err) });
    }
  }
  return { mode: apply ? "applied" : "dry-run", results };
}

/**
 * Iterate every issue in the project that carries `from` and swap it
 * for `to` via relabelIssue's delta semantics. `to === ""` means
 * delete the label from every issue.
 *
 * Pagination intentionally does NOT use `nextPageToken`: each call to
 * relabelIssue removes `from` from the issue, so the set matching the
 * JQL shrinks between pages. A cursor anchored to the original
 * snapshot would skip items; re-running page 1 every iteration keeps
 * the cursor aligned with the current result set. The MAX_PAGES cap
 * bounds run-time; a post-sweep probe confirms nothing matches
 * before returning, so a truncated sweep fails loudly instead of
 * reporting success while leaving issues behind.
 */
async function sweepLabel(rest, target, caches, ctx, from, to) {
  const jql = `project = "${target.project}" AND labels = "${escapeJqlString(from)}"`;
  let touched = 0;
  let hitCap = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await rest("POST", "/rest/api/3/search/jql", {
      body: { jql, maxResults: MAX_PAGE_SIZE, fields: ["labels"] },
    });
    const batch = Array.isArray(data?.issues) ? data.issues : [];
    if (batch.length === 0) return touched;
    for (const issue of batch) {
      const add = to.length > 0 ? [to] : [];
      await jiraRelabelIssue(rest, target, caches, ctx, {
        issueId: issue.key,
        add,
        remove: [from],
      });
      touched++;
    }
    if (page === MAX_PAGES - 1) hitCap = true;
  }
  if (hitCap) {
    // Probe: is there still a matching issue? If yes, the caller's
    // rename/delete is only partially applied; surface the miss.
    const probe = await rest("POST", "/rest/api/3/search/jql", {
      body: { jql, maxResults: 1, fields: ["labels"] },
    });
    if (Array.isArray(probe?.issues) && probe.issues.length > 0) {
      throw new Error(
        `Jira labels.relabelBulk: swept ${touched} issues carrying '${from}' but more still match after ${MAX_PAGES} pages; partial rename. Re-run with a narrower batch or raise MAX_PAGES.`,
      );
    }
  }
  return touched;
}

// ── Stub namespaces ─────────────────────────────────────────────────

function makeReviewStub() {
  const stub = {};
  const why =
    "Jira has no native pull-request surface; configure a separate tracker target for code review (e.g. trackers.review.kind = 'github') and wire pr-iteration against that.";
  for (const op of REVIEW_METHODS) {
    stub[op] = async () => {
      throw new NotSupportedError(why, { kind: "jira", op, namespace: "review" });
    };
  }
  return stub;
}

function makeProjectsStub() {
  const stub = {};
  const why =
    "Jira's custom-field model is instance-specific and does not map onto the Tracker.projects contract (GitHub Project v2). Configure the equivalent fields directly on the Jira issue type.";
  for (const op of TRACKER_NAMESPACES.projects) {
    stub[op] = async () => {
      throw new NotSupportedError(why, { kind: "jira", op, namespace: "projects" });
    };
  }
  return stub;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Build a real Jira tracker.
 *
 * @param {object} target  ops.config tracker entry (needs `site` +
 *   `project`; optional `labels_field` reserved for a future release).
 * @param {object} [opts]
 * @param {Function} [opts.rest]  REST caller for dependency injection
 *   (defaults to the real Jira REST v3 via fetch + Basic auth).
 */
export function makeJiraTracker(target = {}, { rest = null } = {}) {
  const rawApi = rest || defaultRest;
  // Bind target.site as baseUrl so callers don't need to set
  // JIRA_BASE_URL when the config already names the host. A bare-host
  // value is normalised to https by defaultRest; an injected rest fn
  // sees whatever the caller passed.
  const api = target.site
    ? (method, path, opts = {}) => rawApi(method, path, { ...opts, baseUrl: target.site })
    : rawApi;
  const caches = createCaches();

  const issues = {
    createIssue: (ctx, payload) => jiraCreateIssue(api, target, caches, ctx, payload),
    updateIssueStatus: (ctx, payload) => jiraUpdateIssueStatus(api, target, caches, ctx, payload),
    comment: (ctx, payload) => jiraComment(api, target, caches, ctx, payload),
    relabelIssue: (ctx, payload) => jiraRelabelIssue(api, target, caches, ctx, payload),
    getIssue: (ctx, payload) => jiraGetIssue(api, target, caches, ctx, payload),
    listIssues: (ctx, payload) => jiraListIssues(api, target, caches, ctx, payload),
  };

  const labels = {
    reconcileLabels: (ctx, payload) => jiraReconcileLabels(api, target, caches, ctx, payload),
    relabelBulk: (ctx, payload) => jiraRelabelBulk(api, target, caches, ctx, payload),
  };

  const review = makeReviewStub();
  const projects = makeProjectsStub();

  // Coverage asserts: mirror the shape every other real backend uses.
  const missingIssues = TRACKER_NAMESPACES.issues.filter((m) => typeof issues[m] !== "function");
  if (missingIssues.length > 0) {
    throw new Error(`makeJiraTracker: missing issues methods [${missingIssues.join(", ")}]`);
  }
  const missingLabels = TRACKER_NAMESPACES.labels.filter((m) => typeof labels[m] !== "function");
  if (missingLabels.length > 0) {
    throw new Error(`makeJiraTracker: missing labels methods [${missingLabels.join(", ")}]`);
  }
  const missingReview = REVIEW_METHODS.filter((m) => typeof review[m] !== "function");
  if (missingReview.length > 0) {
    throw new Error(`makeJiraTracker: missing review methods [${missingReview.join(", ")}]`);
  }
  const missingProjects = TRACKER_NAMESPACES.projects.filter((m) => typeof projects[m] !== "function");
  if (missingProjects.length > 0) {
    throw new Error(`makeJiraTracker: missing projects methods [${missingProjects.join(", ")}]`);
  }

  return {
    kind: "jira",
    target,
    review,
    issues,
    labels,
    projects,
  };
}
