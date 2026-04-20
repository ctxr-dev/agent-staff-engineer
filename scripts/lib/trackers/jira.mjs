// lib/trackers/jira.mjs
// Placeholder Jira tracker. Every namespace method throws
// NotSupportedError. A real impl lands in a follow-up PR once the
// GitHub surface stabilises; this stub is wired into the dispatcher
// so a project with `trackers.dev.kind === "jira"` fails loudly at
// the first op rather than silently dropping through to a generic
// "method is not a function" error.
//
// Real impl will authenticate against Atlassian REST via a token in
// the JIRA_API_TOKEN env var, or delegate to `jira-cli` when present.

import { makeStubTracker } from "./stub.mjs";

export function makeJiraTracker(target = {}) {
  return makeStubTracker("jira", target);
}
