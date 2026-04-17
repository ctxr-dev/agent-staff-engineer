import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, enumerateKeys } from "../scripts/lib/schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..");

describe("schema.validate primitives", () => {
  it("accepts matching types", () => {
    const s = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
    const { ok } = validate(s, { n: 7 });
    assert.equal(ok, true);
  });

  it("rejects wrong types with a path-aware error", () => {
    const s = { type: "object", properties: { n: { type: "integer" } } };
    const res = validate(s, { n: "seven" });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.path === "$.n"));
  });

  it("reports missing required keys", () => {
    const s = { type: "object", required: ["a", "b"], properties: { a: {}, b: {} } };
    const res = validate(s, { a: 1 });
    assert.ok(res.errors.some((e) => e.path === "$.b"));
  });

  it("rejects undeclared keys when additionalProperties is false", () => {
    const s = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    const res = validate(s, { a: "ok", extra: 1 });
    assert.equal(res.ok, false);
  });

  it("enforces enum values", () => {
    const s = { type: "string", enum: ["red", "green"] };
    assert.equal(validate(s, "red").ok, true);
    assert.equal(validate(s, "blue").ok, false);
  });

  it("rejects arrays where objects are expected and vice versa", () => {
    const s = { type: "object", properties: { a: { type: "array" } } };
    assert.equal(validate(s, { a: [] }).ok, true);
    // object-shaped-as-array confusion in deepEqual would falsely accept here
    // before the fix; we check that array vs object no longer collide.
    assert.equal(validate(s, { a: { 0: "x" } }).ok, false);
  });

  it("throws on unknown type in the schema itself (catches typos)", () => {
    // ajv rejects schemas with invalid `type` at compile time; message phrasing
    // changes between versions, so match on the generic shape.
    const s = { type: "object", properties: { a: { type: "String" } } };
    assert.throws(
      () => validate(s, { a: "x" }),
      (err) => /type|allowed values|schema is invalid/i.test(err.message)
    );
  });
});

describe("schema.validate patterns", () => {
  it("enforces pattern on strings", () => {
    const s = { type: "string", pattern: "^[a-z]+$" };
    assert.equal(validate(s, "abc").ok, true);
    assert.equal(validate(s, "ABC").ok, false);
  });

  it("enforces minLength and minimum", () => {
    assert.equal(validate({ type: "string", minLength: 3 }, "ab").ok, false);
    assert.equal(validate({ type: "number", minimum: 10 }, 5).ok, false);
  });
});

describe("schema.validate composition", () => {
  it("resolves $ref to definitions", () => {
    const s = {
      definitions: { name: { type: "string", minLength: 1 } },
      type: "object",
      properties: { who: { $ref: "#/definitions/name" } },
    };
    assert.equal(validate(s, { who: "alex" }).ok, true);
    assert.equal(validate(s, { who: "" }).ok, false);
  });

  it("oneOf with one match passes; zero or two fails", () => {
    const s = {
      oneOf: [
        { type: "string", pattern: "^A" },
        { type: "string", pattern: "^B" },
      ],
    };
    assert.equal(validate(s, "Alpha").ok, true);
    assert.equal(validate(s, "Zulu").ok, false);
  });
});

describe("enumerateKeys", () => {
  it("enumerates every dotted path from a schema", () => {
    const s = {
      properties: {
        a: { properties: { b: {}, c: { items: { properties: { d: {} } } } } },
      },
    };
    const keys = enumerateKeys(s);
    assert.ok(keys.has("a"));
    assert.ok(keys.has("a.b"));
    assert.ok(keys.has("a.c"));
    assert.ok(keys.has("a.c[].d"));
  });
});

// Cross-check: the real schema validates the real example config. Protects
// the whole bundle in one test.
describe("schema vs example config", () => {
  it("schemas/ops.config.schema.json validates examples/ops.config.example.json", async () => {
    const schema = JSON.parse(await readFile(join(BUNDLE, "schemas", "ops.config.schema.json"), "utf8"));
    const example = JSON.parse(await readFile(join(BUNDLE, "examples", "ops.config.example.json"), "utf8"));
    const res = validate(schema, example);
    if (!res.ok) {
      const detail = res.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join("\n");
      assert.fail(`example failed schema:\n${detail}`);
    }
  });
});
