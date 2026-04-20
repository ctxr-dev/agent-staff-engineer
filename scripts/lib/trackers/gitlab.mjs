// lib/trackers/gitlab.mjs
// Placeholder GitLab tracker. See jira.mjs for rationale. Real impl
// authenticates via GITLAB_TOKEN env var and uses the `glab` CLI (or
// GitLab REST/GraphQL direct when glab isn't present).

import { makeStubTracker } from "./stub.mjs";

export function makeGitlabTracker(target = {}) {
  return makeStubTracker("gitlab", target);
}
