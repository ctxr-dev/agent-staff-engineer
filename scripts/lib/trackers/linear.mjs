// lib/trackers/linear.mjs
// Placeholder Linear tracker. See jira.mjs for rationale. Real impl
// authenticates via LINEAR_API_KEY env var and uses Linear's GraphQL
// API.

import { makeStubTracker } from "./stub.mjs";

export function makeLinearTracker(target = {}) {
  return makeStubTracker("linear", target);
}
