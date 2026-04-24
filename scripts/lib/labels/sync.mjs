// lib/labels/sync.mjs
// Reads the canonical label taxonomy YAML and reconciles labels on one
// or more GitHub repos via `gh label create --force`. Never deletes.
// Color/description diffs on existing labels are reported but not
// overwritten unless force=true.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { load: yamlLoad } = require("js-yaml");
import { ghExec } from "../ghExec.mjs";

/**
 * Parse the taxonomy YAML into a flat array of { name, color, description }
 * where name is "family:label" (e.g. "type:feature").
 */
export function parseTaxonomy(yamlContent) {
  const doc = yamlLoad(yamlContent);
  if (!doc || !doc.families) {
    throw new TypeError("taxonomy YAML must have a top-level 'families' key");
  }
  const labels = [];
  for (const [family, def] of Object.entries(doc.families)) {
    if (!Array.isArray(def.labels)) continue;
    const defaultColor = def.default_color ?? "EDEDED";
    for (const entry of def.labels) {
      labels.push({
        name: `${family}:${entry.name}`,
        color: entry.color ?? defaultColor,
        description: entry.description ?? `Subsystem: ${entry.name}`,
      });
    }
  }
  return labels;
}

/**
 * Load and parse the taxonomy from a file path.
 */
export async function loadTaxonomy(taxonomyPath) {
  const content = await readFile(taxonomyPath, "utf8");
  return parseTaxonomy(content);
}

/**
 * Fetch existing labels from a GitHub repo.
 * Returns a Map<name, { color, description }>.
 */
export async function fetchRepoLabels(owner, repo) {
  const result = ghExec(["label", "list", "--repo", `${owner}/${repo}`, "--json", "name,color,description", "--limit", "200"]);
  if (result.status !== 0) {
    throw new Error(`gh label list failed for ${owner}/${repo}: ${result.stderr}`);
  }
  const labels = JSON.parse(result.stdout);
  const map = new Map();
  for (const l of labels) {
    map.set(l.name, { color: l.color?.replace(/^#/, "") ?? "", description: l.description ?? "" });
  }
  return map;
}

/**
 * Sync labels from taxonomy to a single repo.
 * Returns { created, skipped, diffs } where diffs is an array of
 * { name, field, expected, actual } for labels that exist but differ.
 */
export async function syncLabelsToRepo(taxonomyLabels, owner, repo, extensions = []) {
  const allLabels = [...taxonomyLabels, ...extensions];
  const existing = await fetchRepoLabels(owner, repo);
  const created = [];
  const skipped = [];
  const diffs = [];

  for (const label of allLabels) {
    const current = existing.get(label.name);
    if (!current) {
      const result = ghExec([
        "label", "create", label.name,
        "--repo", `${owner}/${repo}`,
        "--color", label.color,
        "--description", label.description,
        "--force",
      ]);
      if (result.status === 0) {
        created.push(label.name);
      } else {
        skipped.push({ name: label.name, reason: result.stderr.trim() });
      }
    } else {
      const colorNorm = (c) => (c ?? "").replace(/^#/, "").toLowerCase();
      if (colorNorm(current.color) !== colorNorm(label.color)) {
        diffs.push({ name: label.name, field: "color", expected: label.color, actual: current.color });
      }
      if (label.description && current.description !== label.description) {
        diffs.push({ name: label.name, field: "description", expected: label.description, actual: current.description });
      }
      skipped.push({ name: label.name, reason: "exists" });
    }
  }

  return { created, skipped, diffs };
}

/**
 * Build extension labels from ops.config.json taxonomy extensions.
 * Returns flat array of { name, color, description }.
 */
export function buildExtensionLabels(extensions, defaultColors) {
  const labels = [];
  for (const area of extensions?.areas ?? []) {
    labels.push({
      name: `area:${area}`,
      color: defaultColors?.area ?? "8B4FBC",
      description: `Subsystem: ${area}`,
    });
  }
  for (const release of extensions?.releases ?? []) {
    labels.push({
      name: `release:${release}`,
      color: defaultColors?.release ?? "0E8A16",
      description: `Target release: ${release}`,
    });
  }
  for (const phase of extensions?.phases ?? []) {
    labels.push({
      name: `phase:${phase}`,
      color: defaultColors?.phase ?? "FBCA04",
      description: `Phase: ${phase}`,
    });
  }
  return labels;
}
