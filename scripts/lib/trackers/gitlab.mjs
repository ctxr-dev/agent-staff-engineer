// lib/trackers/gitlab.mjs
// Real GitLab tracker backend. Uses GitLab REST API v4 via global
// fetch (Node >=20). No glab CLI dependency.
//
// Auth: GITLAB_TOKEN env var (Private-Token header).
//
// Implemented namespaces:
//   issues.*   — full (createIssue, updateIssueStatus, comment,
//                relabelIssue, getIssue, listIssues)
//   labels.*   — full (reconcileLabels, relabelBulk)
//   review.*   — partial (pollForReview, fetchUnresolvedThreads,
//                resolveThread, ciStateOnHead; requestReview stubbed)
//   projects.* — stub (GitLab has no GitHub-style Project v2)

import {
  NotSupportedError,
  REVIEW_METHODS,
  TRACKER_NAMESPACES,
} from "./tracker.mjs";

const DEFAULT_GITLAB_URL = "https://gitlab.com";
const MAX_PER_PAGE = 100;
const MAX_PAGES = 10;

// ── REST helper ─────────────────────────────────────────────────────

async function defaultRest(method, path, { body = null, query = {}, baseUrl: overrideBase = null } = {}) {
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    throw new Error(
      "GITLAB_TOKEN environment variable is required for GitLab tracker operations",
    );
  }
  const baseUrl = overrideBase || process.env.GITLAB_URL || DEFAULT_GITLAB_URL;
  const url = new URL(`/api/v4${path}`, baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const opts = {
    method,
    headers: {
      "Private-Token": token,
      "Content-Type": "application/json",
    },
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(url.toString(), opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API ${method} ${path} returned ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Helpers ─────────────────────────────────────────────────────────

function projectPath(target) {
  const id = target.project_id;
  if (id) return encodeURIComponent(String(id));
  // Accept project_path (ops.config canonical) or namespace+repo
  const pp = target.project_path;
  if (pp) return encodeURIComponent(pp);
  const ns = target.namespace || target.owner;
  const repo = target.repo;
  if (!ns || !repo) {
    throw new Error(
      "GitLab tracker requires target.project_id, target.project_path, or target.namespace + target.repo",
    );
  }
  return encodeURIComponent(`${ns}/${repo}`);
}

function createCaches() {
  return { labelMap: null };
}

// ── Label helpers ───────────────────────────────────────────────────

async function resolveLabelMap(api, target, caches) {
  if (caches.labelMap) return caches.labelMap;
  const pid = projectPath(target);
  const map = new Map();
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const labels = await api("GET", `/projects/${pid}/labels`, {
      query: { per_page: MAX_PER_PAGE, page },
    });
    if (!Array.isArray(labels)) break;
    for (const l of labels) {
      map.set(l.name.toLowerCase(), l);
    }
    if (labels.length < MAX_PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
  }
  if (truncated) {
    throw new Error(
      `GitLab: project has more than ${MAX_PAGES * MAX_PER_PAGE} labels; label resolution was truncated.`,
    );
  }
  caches.labelMap = map;
  return map;
}

async function resolveLabelNames(api, target, caches, names) {
  const map = await resolveLabelMap(api, target, caches);
  const missing = [];
  const seen = new Set();
  const resolved = [];
  for (const name of names) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `gitlab: every label name must be a non-empty string; got ${JSON.stringify(name)}`,
      );
    }
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = map.get(key);
    if (label) resolved.push(label.name);
    else missing.push(name.trim());
  }
  if (missing.length > 0) {
    throw new Error(
      `GitLab: labels not found: ${missing.join(", ")}. Create them first via labels.reconcileLabels.`,
    );
  }
  return resolved;
}

// ── issues.* ────────────────────────────────────────────────────────

async function gitlabCreateIssue(api, target, caches, _ctx, payload) {
  let { title, body = "", labels = [] } = payload ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TypeError("gitlab issues.createIssue: title must be a non-empty string");
  }
  title = title.trim();
  if (typeof body !== "string") {
    throw new TypeError("gitlab issues.createIssue: body must be a string when provided");
  }
  if (!Array.isArray(labels)) {
    throw new TypeError("gitlab issues.createIssue: labels must be an array of label names");
  }
  if (payload?.templateName != null) {
    throw new Error(
      "gitlab issues.createIssue: templateName is not supported; render the body before calling createIssue",
    );
  }
  labels = labels.map((l) => {
    if (typeof l !== "string" || l.trim().length === 0) {
      throw new TypeError(
        `gitlab issues.createIssue: every labels[] entry must be a non-empty string; got ${JSON.stringify(l)}`,
      );
    }
    return l.trim();
  });
  const pid = projectPath(target);

  // Dedupe: search open issues by exact title
  const DEDUPE_MAX = 500;
  let dedupeScanned = 0;
  let match = null;
  for (let page = 1; dedupeScanned < DEDUPE_MAX; page++) {
    const issues = await api("GET", `/projects/${pid}/issues`, {
      query: { state: "opened", search: title, per_page: MAX_PER_PAGE, page },
    });
    if (!Array.isArray(issues) || issues.length === 0) break;
    match = issues.find((i) => i.title === title);
    if (match) break;
    dedupeScanned += issues.length;
    if (issues.length < MAX_PER_PAGE) break;
  }
  if (match) {
    return {
      id: match.id,
      iid: match.iid,
      url: match.web_url,
      existed: true,
    };
  }

  const labelNames = labels.length > 0
    ? (await resolveLabelNames(api, target, caches, labels)).join(",")
    : undefined;
  const created = await api("POST", `/projects/${pid}/issues`, {
    body: { title, description: body || undefined, labels: labelNames },
  });
  if (!created?.id) {
    throw new Error("gitlab issues.createIssue: API returned no issue");
  }
  return {
    id: created.id,
    iid: created.iid,
    url: created.web_url,
    existed: false,
  };
}

async function gitlabUpdateIssueStatus(api, target, _caches, _ctx, payload) {
  const { issueId, status } = payload ?? {};
  if (!issueId) {
    throw new TypeError("gitlab issues.updateIssueStatus: issueId (iid) is required");
  }
  if (typeof status !== "string" || status.trim().length === 0) {
    throw new TypeError("gitlab issues.updateIssueStatus: status must be a non-empty string");
  }
  const lower = status.trim().toLowerCase();
  if (lower === "done" || lower === "closed") {
    throw new Error(
      "gitlab issues.updateIssueStatus: refusing to close/done; that is a human gate per rules/pr-workflow.md",
    );
  }
  const pid = projectPath(target);
  // GitLab issues are binary: open or closed. Map vocabulary keys.
  // "backlog", "ready", "in_progress", "in_review" all map to "reopen" (open).
  const stateEvent = "reopen";
  const current = await api("GET", `/projects/${pid}/issues/${issueId}`);
  if (!current) {
    throw new Error(`gitlab issues.updateIssueStatus: issue ${issueId} not found`);
  }
  if (current.state === "opened") {
    return { id: current.id, iid: current.iid, state: current.state, noop: true };
  }
  const updated = await api("PUT", `/projects/${pid}/issues/${issueId}`, {
    body: { state_event: stateEvent },
  });
  return { id: updated.id, iid: updated.iid, state: updated.state };
}

async function gitlabComment(api, target, _caches, _ctx, payload) {
  const { issueId, body } = payload ?? {};
  if (!issueId) {
    throw new TypeError("gitlab issues.comment: issueId (iid) is required");
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new TypeError("gitlab issues.comment: body must be a non-empty string");
  }
  const pid = projectPath(target);
  const note = await api("POST", `/projects/${pid}/issues/${issueId}/notes`, {
    body: { body },
  });
  if (!note?.id) {
    throw new Error("gitlab issues.comment: API returned no note");
  }
  return { id: note.id };
}

async function gitlabRelabelIssue(api, target, caches, _ctx, payload) {
  const { issueId, add = [], remove = [] } = payload ?? {};
  if (!issueId) {
    throw new TypeError("gitlab issues.relabelIssue: issueId (iid) is required");
  }
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    throw new TypeError("gitlab issues.relabelIssue: add and remove must be arrays");
  }
  for (const name of [...add, ...remove]) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `gitlab issues.relabelIssue: every label must be a non-empty string; got ${JSON.stringify(name)}`,
      );
    }
  }
  const addSet = new Set(add.map((n) => n.trim().toLowerCase()));
  const removeSet = new Set(remove.map((n) => n.trim().toLowerCase()));
  const overlap = [...addSet].filter((n) => removeSet.has(n));
  if (overlap.length > 0) {
    throw new Error(`gitlab issues.relabelIssue: labels in both add and remove: ${overlap.join(", ")}`);
  }
  if (add.length === 0 && remove.length === 0) {
    return { id: issueId, labels: [], noop: true };
  }
  const pid = projectPath(target);
  // GitLab REST uses add_labels / remove_labels
  const body = {};
  if (add.length > 0) {
    body.add_labels = (await resolveLabelNames(api, target, caches, add)).join(",");
  }
  if (remove.length > 0) {
    body.remove_labels = (await resolveLabelNames(api, target, caches, remove)).join(",");
  }
  const updated = await api("PUT", `/projects/${pid}/issues/${issueId}`, { body });
  return {
    id: updated?.id,
    iid: updated?.iid,
    labels: updated?.labels ?? [],
  };
}

async function gitlabGetIssue(api, target, _caches, _ctx, payload) {
  const { issueId } = payload ?? {};
  if (!issueId) {
    throw new TypeError("gitlab issues.getIssue: issueId (iid) is required");
  }
  const pid = projectPath(target);
  const issue = await api("GET", `/projects/${pid}/issues/${issueId}`);
  if (!issue) {
    throw new Error(`gitlab issues.getIssue: issue ${issueId} not found`);
  }
  return issue;
}

async function gitlabListIssues(api, target, caches, _ctx, payload = {}) {
  const { state, labels: filterLabels, first, limit } = payload;
  const rawCap = first ?? limit ?? 50;
  const cap = typeof rawCap === "number" && rawCap > 0
    ? Math.min(Math.floor(rawCap), 1000)
    : 50;
  const pid = projectPath(target);
  const query = { state: "opened", per_page: Math.min(cap, MAX_PER_PAGE) };
  if (state != null) {
    if (typeof state !== "string") {
      throw new TypeError("gitlab issues.listIssues: state must be a string");
    }
    const lower = state.trim().toLowerCase();
    if (lower === "done" || lower === "closed") query.state = "closed";
  }
  if (filterLabels != null) {
    if (!Array.isArray(filterLabels)) {
      throw new TypeError("gitlab issues.listIssues: labels must be an array");
    }
    if (filterLabels.length > 0) {
      const resolved = await resolveLabelNames(api, target, caches, filterLabels);
      query.labels = resolved.join(",");
    }
  }
  const results = [];
  for (let page = 1; results.length < cap && page <= MAX_PAGES; page++) {
    query.page = page;
    const issues = await api("GET", `/projects/${pid}/issues`, { query });
    if (!Array.isArray(issues) || issues.length === 0) break;
    for (const i of issues) results.push(i);
    if (issues.length < MAX_PER_PAGE) break;
  }
  return results.slice(0, cap);
}

// ── labels.* ────────────────────────────────────────────────────────

async function gitlabReconcileLabels(api, target, caches, _ctx, payload) {
  const raw = payload ?? {};
  const taxonomy = raw.taxonomy ?? raw.desired ?? [];
  const apply = raw.apply === true;
  const allowDeprecate = raw.allowDeprecate === true;
  if (!Array.isArray(taxonomy)) {
    throw new TypeError("gitlab labels.reconcileLabels: taxonomy must be an array");
  }
  const pid = projectPath(target);
  const map = await resolveLabelMap(api, target, caches);
  const plan = [];
  const seenNames = new Set();
  for (const want of taxonomy) {
    if (want == null || (typeof want !== "string" && typeof want !== "object")) {
      throw new TypeError(
        `gitlab labels.reconcileLabels: each entry must be a string or {name, color?}; got ${JSON.stringify(want)}`,
      );
    }
    const name = typeof want === "string" ? want : want.name;
    const color = typeof want === "string" ? undefined : want.color;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError(
        `gitlab labels.reconcileLabels: name must be a non-empty string; got ${JSON.stringify(want)}`,
      );
    }
    if (color != null && (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))) {
      throw new TypeError(
        `gitlab labels.reconcileLabels: color must be hex like '#ff0000'; got ${JSON.stringify(color)}`,
      );
    }
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    const existing = map.get(key);
    if (existing) {
      if (color && existing.color !== color) {
        if (apply) {
          await api("PUT", `/projects/${pid}/labels/${encodeURIComponent(existing.name)}`, {
            body: { new_name: trimmed, color },
          });
          existing.color = color;
        }
        plan.push({ action: "update", name: trimmed });
      } else {
        plan.push({ action: "unchanged", name: trimmed });
      }
    } else {
      if (apply) {
        const created = await api("POST", `/projects/${pid}/labels`, {
          body: { name: trimmed, color: color || "#888888" },
        });
        if (created) map.set(created.name.toLowerCase(), created);
      }
      plan.push({ action: "create", name: trimmed });
    }
  }
  if (allowDeprecate) {
    const taxonomyNames = new Set(
      taxonomy.map((w) => (typeof w === "string" ? w : w.name).trim().toLowerCase()),
    );
    for (const [key, label] of map) {
      if (!taxonomyNames.has(key)) {
        if (apply) {
          await api("DELETE", `/projects/${pid}/labels/${encodeURIComponent(label.name)}`);
        }
        plan.push({ action: "deprecate", name: label.name });
      }
    }
  }
  const result = { mode: apply ? "applied" : "dry-run", plan };
  if (apply) result.applied = true;
  return result;
}

async function gitlabRelabelBulk(api, target, caches, _ctx, payload) {
  const raw = payload ?? {};
  const plan = raw.plan ?? [];
  const apply = raw.apply === true;
  if (!Array.isArray(plan)) {
    throw new TypeError("gitlab labels.relabelBulk: plan must be an array of {from, to}");
  }
  if (plan.length === 0) {
    return { mode: apply ? "applied" : "dry-run", results: [] };
  }
  const pid = projectPath(target);
  const results = [];
  for (const entry of plan) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      results.push({ from: null, to: null, success: false, error: "invalid entry" });
      continue;
    }
    const from = entry.from;
    const to = entry.to;
    if (typeof from !== "string" || from.trim().length === 0 ||
        typeof to !== "string" || to.trim().length === 0) {
      results.push({ from: from ?? null, to: to ?? null, success: false, error: "from and to must be non-empty strings" });
      continue;
    }
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      results.push({ from, to, success: true, action: "no-op" });
      continue;
    }
    if (!apply) {
      results.push({ from, to, success: true, action: "would-rename" });
      continue;
    }
    try {
      await api("PUT", `/projects/${pid}/labels/${encodeURIComponent(from.trim())}`, {
        body: { new_name: to.trim() },
      });
      results.push({ from, to, success: true, action: "renamed" });
    } catch (err) {
      results.push({ from, to, success: false, error: err?.message ?? String(err) });
    }
  }
  caches.labelMap = null;
  return { mode: apply ? "applied" : "dry-run", results };
}

// ── review.* (partial) ──────────────────────────────────────────────

async function gitlabPollForReview(api, target, _caches, ctx) {
  const mrIid = ctx?.mrIid ?? ctx?.prNumber;
  if (!mrIid) throw new TypeError("gitlab review.pollForReview: ctx.mrIid (or ctx.prNumber) is required");
  const pid = projectPath(target);
  const mr = await api("GET", `/projects/${pid}/merge_requests/${mrIid}`);
  // CI state from pipeline
  const ciMap = {
    success: "SUCCESS",
    failed: "FAILURE",
    canceled: "ERROR",
    running: "PENDING",
    pending: "PENDING",
    created: "PENDING",
    manual: "PENDING",
  };
  const pipelineStatus = mr?.head_pipeline?.status ?? "pending";
  const ciState = ciMap[pipelineStatus] ?? "PENDING";
  // Unresolved threads (paginated)
  const allDiscussions = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await api("GET", `/projects/${pid}/merge_requests/${mrIid}/discussions`, {
      query: { per_page: MAX_PER_PAGE, page },
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const d of batch) allDiscussions.push(d);
    if (batch.length < MAX_PER_PAGE) break;
  }
  let unresolvedCount = 0;
  for (const d of allDiscussions) {
    if (Array.isArray(d.notes) && d.notes.some((n) => n.resolvable && !n.resolved)) {
      unresolvedCount++;
    }
  }
  // reviewOnHead: check if any resolvable note references the current HEAD SHA
  const headSha = mr?.diff_refs?.head_sha ?? mr?.sha;
  let reviewOnHead = false;
  if (headSha) {
    for (const d of allDiscussions) {
      for (const n of d.notes ?? []) {
        if (n.resolvable && n.position?.head_sha === headSha) {
          reviewOnHead = true;
          break;
        }
      }
      if (reviewOnHead) break;
    }
  }
  return { ciState, unresolvedCount, reviewOnHead };
}

async function gitlabFetchUnresolvedThreads(api, target, _caches, ctx) {
  const mrIid = ctx?.mrIid ?? ctx?.prNumber;
  if (!mrIid) throw new TypeError("gitlab review.fetchUnresolvedThreads: ctx.mrIid is required");
  const pid = projectPath(target);
  const threads = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const discussions = await api("GET", `/projects/${pid}/merge_requests/${mrIid}/discussions`, {
      query: { per_page: MAX_PER_PAGE, page },
    });
    if (!Array.isArray(discussions) || discussions.length === 0) break;
    for (const d of discussions) {
      if (!Array.isArray(d.notes) || d.notes.length === 0) continue;
      // Find the first resolvable note (not always d.notes[0])
      const resolvableNote = d.notes.find((n) => n.resolvable);
      if (!resolvableNote) continue;
      const isUnresolved = d.notes.some((n) => n.resolvable && !n.resolved);
      if (!isUnresolved) continue;
      threads.push({
        id: d.id,
        path: resolvableNote.position?.new_path ?? null,
        line: resolvableNote.position?.new_line ?? null,
        isOutdated: resolvableNote.position?.line_range == null && resolvableNote.position?.new_line == null,
        commitSha: resolvableNote.position?.head_sha ?? null,
        authorLogin: resolvableNote.author?.username ?? null,
        body: resolvableNote.body ?? "",
      });
    }
    if (discussions.length < MAX_PER_PAGE) break;
  }
  return threads;
}

async function gitlabResolveThread(api, target, _caches, ctx, threadId) {
  const mrIid = ctx?.mrIid ?? ctx?.prNumber;
  if (!mrIid) throw new TypeError("gitlab review.resolveThread: ctx.mrIid is required");
  const discussionId = threadId;
  if (!discussionId) throw new TypeError("gitlab review.resolveThread: threadId is required");
  const pid = projectPath(target);
  return api("PUT", `/projects/${pid}/merge_requests/${mrIid}/discussions/${discussionId}`, {
    body: { resolved: true },
  });
}

async function gitlabCiStateOnHead(api, target, _caches, ctx) {
  const mrIid = ctx?.mrIid ?? ctx?.prNumber;
  if (!mrIid) throw new TypeError("gitlab review.ciStateOnHead: ctx.mrIid is required");
  const pid = projectPath(target);
  const mr = await api("GET", `/projects/${pid}/merge_requests/${mrIid}`);
  const ciMap = {
    success: "SUCCESS",
    failed: "FAILURE",
    canceled: "ERROR",
    running: "PENDING",
    pending: "PENDING",
    created: "PENDING",
    manual: "PENDING",
  };
  return ciMap[mr?.head_pipeline?.status ?? "pending"] ?? "PENDING";
}

// ── projects.* stub ─────────────────────────────────────────────────

function makeProjectsStub() {
  const stub = {};
  for (const op of TRACKER_NAMESPACES.projects) {
    stub[op] = async () => {
      throw new NotSupportedError(
        "GitLab has no GitHub-style Project v2 board. Use issues with labels and milestones instead.",
        { kind: "gitlab", op, namespace: "projects" },
      );
    };
  }
  return stub;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Build a real GitLab tracker.
 *
 * @param {object} target  ops.config tracker entry (needs namespace+repo or project_id)
 * @param {object} [opts]
 * @param {Function} [opts.rest]  REST caller for dependency injection
 *   (defaults to real GitLab API via fetch + GITLAB_TOKEN)
 */
export function makeGitlabTracker(target = {}, { rest = null } = {}) {
  const rawApi = rest || defaultRest;
  // Wrap to inject target.host as baseUrl for self-hosted GitLab instances
  const api = target.host
    ? (method, path, opts = {}) => rawApi(method, path, { ...opts, baseUrl: target.host })
    : rawApi;
  const caches = createCaches();

  const issues = {
    createIssue: (ctx, payload) => gitlabCreateIssue(api, target, caches, ctx, payload),
    updateIssueStatus: (ctx, payload) => gitlabUpdateIssueStatus(api, target, caches, ctx, payload),
    comment: (ctx, payload) => gitlabComment(api, target, caches, ctx, payload),
    relabelIssue: (ctx, payload) => gitlabRelabelIssue(api, target, caches, ctx, payload),
    getIssue: (ctx, payload) => gitlabGetIssue(api, target, caches, ctx, payload),
    listIssues: (ctx, payload) => gitlabListIssues(api, target, caches, ctx, payload),
  };

  const labels = {
    reconcileLabels: (ctx, payload) => gitlabReconcileLabels(api, target, caches, ctx, payload),
    relabelBulk: (ctx, payload) => gitlabRelabelBulk(api, target, caches, ctx, payload),
  };

  const review = {
    requestReview: async () => {
      throw new NotSupportedError(
        "GitLab's approval flow requires admin-configured approval rules; manual reviewer assignment is not yet wired. Configure approval rules at the project level and the MR will surface for review automatically.",
        { kind: "gitlab", op: "requestReview", namespace: "review" },
      );
    },
    pollForReview: (ctx) => gitlabPollForReview(api, target, caches, ctx),
    fetchUnresolvedThreads: (ctx) => gitlabFetchUnresolvedThreads(api, target, caches, ctx),
    resolveThread: (ctx, threadId) => gitlabResolveThread(api, target, caches, ctx, threadId),
    ciStateOnHead: (ctx) => gitlabCiStateOnHead(api, target, caches, ctx),
  };

  // Coverage asserts
  const missingIssues = TRACKER_NAMESPACES.issues.filter((m) => typeof issues[m] !== "function");
  if (missingIssues.length > 0) {
    throw new Error(`makeGitlabTracker: missing issues methods [${missingIssues.join(", ")}]`);
  }
  const missingLabels = TRACKER_NAMESPACES.labels.filter((m) => typeof labels[m] !== "function");
  if (missingLabels.length > 0) {
    throw new Error(`makeGitlabTracker: missing labels methods [${missingLabels.join(", ")}]`);
  }
  const missingReview = REVIEW_METHODS.filter((m) => typeof review[m] !== "function");
  if (missingReview.length > 0) {
    throw new Error(`makeGitlabTracker: missing review methods [${missingReview.join(", ")}]`);
  }

  return {
    kind: "gitlab",
    target,
    review,
    issues,
    labels,
    projects: makeProjectsStub(),
  };
}
