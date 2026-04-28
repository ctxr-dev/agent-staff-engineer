// scripts/lib/knowledge/validate.mjs
//
// JSON-Schema validation for knowledge-entry frontmatter, plus a few
// invariants the schema can't express:
//   - id matches the filename basename (without extension)
//   - last_verified >= first_seen
//   - parents and related ids are not the entry's own id (no self-link)
//   - type === 'leaf' for entries under <wiki>/knowledge/<domain>/<slug>.md
//     (cluster / domain entries live in index.md files written by the
//     wiki tooling; the human authoring path goes through leaves only)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "..", "..", "..", "schemas", "knowledge-entry.schema.json");
let _schema = null;
let _ajv = null;
let _validator = null;

function ajvValidator() {
  if (_validator) return _validator;
  _schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  _ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(_ajv);
  _validator = _ajv.compile(_schema);
  return _validator;
}

/**
 * Validate one knowledge-entry frontmatter object plus the path it
 * lives at. Returns {ok, errors[]} so callers can collect every
 * violation in one pass.
 *
 * @param {object} data    parsed frontmatter
 * @param {string} entryPath  absolute path to the .md file (used for
 *                            id-vs-filename + path-shape invariants)
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEntry(data, entryPath) {
  const errors = [];
  const validate = ajvValidator();
  // Validate against the SHAPE that will actually be written to disk.
  // serialiseEntry strips undefined values via orderedFrontmatter, so
  // a caller that spreads optionals (e.g. `{...base, owner: maybeOwner}`
  // where maybeOwner === undefined) lands a frontmatter object that
  // ajv would otherwise flag as schema-violating even though `owner`
  // never reaches the file. Strip undefined here so validation
  // matches the on-disk reality.
  const stripped = stripUndefined(data);
  const ok = validate(stripped);
  if (!ok) {
    for (const e of validate.errors ?? []) {
      const at = e.instancePath || "/";
      errors.push(`${at} ${e.message ?? "schema violation"}`);
    }
  }
  // Schema-independent invariants:
  if (typeof data?.id === "string" && typeof entryPath === "string" && entryPath.length > 0) {
    // Platform-agnostic basename: split on either separator and
    // take the last non-empty segment. path.basename() uses the
    // host's native separator and would not split a Windows-style
    // path on POSIX (or vice versa), which the rest of this
    // module already handles via /[\\/]/ for the knowledge-segment
    // check. Mirror that approach here so the same `data.id` ->
    // filename invariant fires regardless of which separator the
    // caller passed.
    const segments = entryPath.split(/[\\/]+/).filter(Boolean);
    const last = segments.length > 0 ? segments[segments.length - 1] : entryPath;
    const base = last.replace(/\.md$/i, "");
    if (data.id !== base) {
      errors.push(`/id "${data.id}" must match the filename basename "${base}" (without .md)`);
    }
  }
  if (typeof data?.first_seen === "string" && typeof data?.last_verified === "string") {
    if (data.last_verified < data.first_seen) {
      errors.push(`/last_verified must be >= first_seen (got ${data.last_verified} vs ${data.first_seen})`);
    }
  }
  if (Array.isArray(data?.parents) && typeof data?.id === "string") {
    if (data.parents.includes(data.id)) errors.push("/parents must not include the entry's own id");
  }
  if (Array.isArray(data?.related) && typeof data?.id === "string") {
    if (data.related.includes(data.id)) errors.push("/related must not include the entry's own id");
  }
  // type must be 'leaf' for entries written into the knowledge/ tree.
  // cluster / domain index.md files are owned by the wiki tooling, not
  // by this writer.
  //
  // Path-separator handling: split on /[\\/]+/ rather than `${sep}knowledge${sep}`
  // so a Windows host that received a POSIX-style path (e.g. an absolute
  // path passed in from a config) and a POSIX host that received a
  // backslash-style path both detect the segment correctly. The previous
  // `sep`-only check missed every cross-style mix, which let a leaf
  // skip the type-must-be-"leaf" invariant on Windows.
  if (typeof entryPath === "string" && entryPath.split(/[\\/]+/).includes("knowledge")) {
    if (data?.type !== "leaf") {
      errors.push(`/type must be "leaf" for entries under knowledge/ (got ${JSON.stringify(data?.type)})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Strip own properties whose value is undefined. Mirrors the
// serialiseEntry/orderedFrontmatter contract that drops undefined
// keys before writing to disk; we validate the post-strip shape so
// validateEntry never rejects a record for a field that would not
// actually land in the file.
function stripUndefined(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

// Reset the cached validator (test-only seam; production callers never
// need this since the schema doesn't change at runtime).
export function _resetForTests() {
  _schema = null;
  _ajv = null;
  _validator = null;
}
