// scripts/lib/knowledge/frontmatter.mjs
//
// Parse and serialise the YAML frontmatter that gates every knowledge
// entry under <wikiRoot>/knowledge/<domain>/<slug>.md, where wikiRoot
// is the configured wiki root (typically `wiki.roots.shared`).
//
// We use gray-matter (already a runtime dep of the bundle) to read; we
// render the YAML ourselves to keep field ordering deterministic so two
// identical writes produce byte-identical files. JSON-Schema validation
// against schemas/knowledge-entry.schema.json runs through validate.mjs.

import matter from "gray-matter";

// Field render order. Authors may put fields in any order; we always
// re-render in this order so the on-disk frontmatter is deterministic
// across writers / writes.
export const FIELD_ORDER = [
  "id",
  "type",
  "depth_role",
  "focus",
  "covers",
  "parents",
  "shared_covers",
  "kind",
  "entities",
  "related",
  "first_seen",
  "last_verified",
  "source",
  "status",
];

/**
 * Parse a knowledge entry markdown file. Returns {data, content}.
 *
 * @param {string} text  full file content (frontmatter + markdown body)
 * @returns {{data: object, content: string}}
 */
export function parseEntry(text) {
  if (typeof text !== "string") {
    throw new Error("knowledge.parseEntry: text must be a string");
  }
  const parsed = matter(text);
  return {
    data: parsed.data ?? {},
    content: parsed.content ?? "",
  };
}

/**
 * Serialise a knowledge entry to markdown. Frontmatter is rendered
 * with fields in FIELD_ORDER first; any extra keys present on the
 * input object are appended in alphabetical order so two writers
 * composing the same logical object emit byte-identical frontmatter
 * regardless of key insertion order. NOTE: this serialiser does NOT
 * filter unknown fields, but the canonical schema
 * (schemas/knowledge-entry.schema.json) sets `additionalProperties:
 * false`, so `validate.mjs::validateEntry` rejects extras at the
 * write boundary. The alphabetical-extras handling exists so a
 * future schema version that opens up extension points (e.g. a
 * `tags` array) ships with deterministic output the day it lands,
 * not so callers can sneak unknown fields past the validator today.
 * Body content is preserved verbatim.
 *
 * @param {object} data
 * @param {string} content
 * @returns {string}
 */
export function serialiseEntry(data, content) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("knowledge.serialiseEntry: data must be a plain object");
  }
  const ordered = orderedFrontmatter(data);
  const yaml = renderYaml(ordered);
  const body = typeof content === "string" ? content : "";
  // Two-newline separator between frontmatter and body matches the wiki
  // tooling's expectation; trailing newline keeps POSIX text-file rules
  // satisfied so editors / git don't complain.
  const bodyText = body.startsWith("\n") ? body : "\n" + body;
  return `---\n${yaml}---\n${bodyText}${bodyText.endsWith("\n") ? "" : "\n"}`;
}

/**
 * Order the keys of a frontmatter object. Known fields come first in
 * FIELD_ORDER; unknown keys are appended in alphabetical order so the
 * on-disk shape is stable regardless of which writer composed the
 * object (insertion order would let a writer that builds frontmatter
 * via `{...base, custom}` produce a different file than one that uses
 * `{custom, ...base}`).
 *
 * @param {object} data
 * @returns {object}
 */
export function orderedFrontmatter(data) {
  const out = {};
  for (const key of FIELD_ORDER) {
    if (key in data && data[key] !== undefined) out[key] = data[key];
  }
  const extras = Object.keys(data)
    .filter((k) => !FIELD_ORDER.includes(k) && data[k] !== undefined)
    .sort();
  for (const key of extras) out[key] = data[key];
  return out;
}

// ---------- internal YAML renderer ----------
//
// We render YAML by hand for two reasons:
//   1. Deterministic ordering — js-yaml's dump() is stable for
//      primitives but renders some types in surprising shapes (multiline
//      strings, integer keys) that we don't want.
//   2. Zero-effect on the rest of the bundle's YAML usage — keeping
//      this restricted to the small set of types we actually use
//      (string, integer, boolean, array of strings) makes the renderer
//      readable AND makes it easy to predict the exact bytes.

function renderYaml(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${formatScalar(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatScalar(v) {
  if (v == null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`knowledge.frontmatter: cannot serialise non-finite number ${v}`);
    }
    return String(v);
  }
  if (typeof v === "string") {
    // Quote anything that could be misread as a different YAML type, or
    // that contains characters which require quoting. Otherwise emit
    // the bare scalar form for readable diffs.
    if (v.length === 0) return '""';
    if (needsQuotes(v)) return JSON.stringify(v);
    return v;
  }
  throw new Error(`knowledge.frontmatter: unsupported scalar type ${typeof v}`);
}

function needsQuotes(s) {
  // Quote when the string would otherwise parse as a different type or
  // collide with YAML's structural characters. Prefer JSON-style double
  // quotes since they're unambiguous and gray-matter accepts them.
  if (/^[\s]/.test(s) || /[\s]$/.test(s)) return true; // leading/trailing whitespace
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true;
  // ISO dates: gray-matter (via js-yaml) parses bare YYYY-MM-DD
  // scalars as native Date objects. To keep first_seen / last_verified
  // round-tripping as strings, we quote them so the parser keeps the
  // string form intact.
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}(T|$)/.test(s)) return true;
  if (/[:#\n\r\t"'`{}\[\],&*!|>%@]/.test(s)) return true;
  return false;
}
