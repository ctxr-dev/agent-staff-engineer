// lib/schema.mjs
// JSON Schema validator backed by ajv + ajv-formats. Replaces the earlier
// hand-rolled draft-07 subset which had several gaps (no patternProperties
// interaction with additionalProperties:false, no cyclic-$ref guard, no
// oneOf sub-error surfacing, no regex compilation cache). ajv is the
// de-facto standard, compiled once per schema, and returns error objects
// with both `instancePath` and `schemaPath` for precise user-facing messages.
//
// Public API is intentionally the same as before: `validate(schema, value)`
// returns `{ ok, errors: [{ path, message }] }`, and `enumerateKeys(schema)`
// returns a Set of dotted paths known to the schema. No other file in the
// bundle needs to change.

import Ajv from "ajv";
import addFormats from "ajv-formats";

// One Ajv instance is reused across calls so compiled validators are cached
// per schema reference. `allErrors: true` makes error reporting useful;
// `strict: false` lets the schema use JSON-Schema draft-07 features we rely on
// (defaults, oneOf with mixed types) without ajv warning.
const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
addFormats(ajv);

const compiledCache = new WeakMap();

function compile(schema) {
  let validator = compiledCache.get(schema);
  if (!validator) {
    validator = ajv.compile(schema);
    compiledCache.set(schema, validator);
  }
  return validator;
}

/**
 * Validate `value` against `schema`.
 * @returns {{ ok: boolean, errors: {path: string, message: string}[] }}
 */
export function validate(schema, value) {
  const validator = compile(schema);
  const ok = validator(value) === true;
  const errors = [];
  if (!ok) {
    for (const err of validator.errors ?? []) {
      const path = `$${(err.instancePath || "").replace(/\//g, ".")}${err.keyword === "required" ? `.${err.params.missingProperty}` : ""}`;
      errors.push({ path, message: err.message ?? err.keyword ?? "unknown error" });
    }
  }
  return { ok, errors };
}

/** Enumerate every dotted path (properties + items) known to the schema. */
export function enumerateKeys(schema) {
  const paths = new Set();
  const visited = new WeakSet();
  function walk(node, prefix) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (node.$ref && typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      walk(resolveRef(schema, node.$ref), prefix);
    }
    if (node.properties) {
      for (const [k, sub] of Object.entries(node.properties)) {
        const p = prefix ? `${prefix}.${k}` : k;
        paths.add(p);
        walk(sub, p);
      }
    }
    if (node.items) walk(node.items, `${prefix}[]`);
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(node[key])) for (const s of node[key]) walk(s, prefix);
    }
  }
  walk(schema, "");
  return paths;
}

function resolveRef(schema, ref) {
  const segments = ref.slice(2).split("/");
  let node = schema;
  for (const seg of segments) {
    node = node?.[seg];
    if (node === undefined) return undefined;
  }
  return node;
}
