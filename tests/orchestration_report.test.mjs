import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseReport,
  findMatchingOpenBrace,
} from "../scripts/lib/orchestration/report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  await readFile(join(__dirname, "..", "schemas", "soldier-report.schema.json"), "utf8"),
);

describe("findMatchingOpenBrace", () => {
  it("returns -1 on empty input", () => {
    assert.equal(findMatchingOpenBrace(""), -1);
  });

  it("returns -1 when the text doesn't end in '}'", () => {
    assert.equal(findMatchingOpenBrace("prose here"), -1);
    assert.equal(findMatchingOpenBrace("{valid}\n trailing"), -1);
  });

  it("finds the opening brace of a terminal balanced object", () => {
    const text = "prose\n{\"a\":1}";
    assert.equal(findMatchingOpenBrace(text), text.indexOf("{"));
  });

  it("ignores braces inside JSON string values", () => {
    const text = 'prose\n{"note": "has {} inside", "x": 1}';
    const at = findMatchingOpenBrace(text);
    assert.equal(text.slice(at), '{"note": "has {} inside", "x": 1}');
  });

  it("handles escaped quotes inside strings", () => {
    const text = 'prose\n{"escape": "a \\"quoted\\" thing {also}", "y": 2}';
    const at = findMatchingOpenBrace(text);
    assert.equal(at, text.indexOf("{"));
  });

  it("picks the LAST top-level object when multiple are present (but only the last closes at the end)", () => {
    const text = '{"first": true}\nprose\n{"last": true}';
    const at = findMatchingOpenBrace(text);
    assert.equal(text.slice(at), '{"last": true}');
  });

  it("returns -1 on unbalanced input", () => {
    assert.equal(findMatchingOpenBrace("}extra}"), -1);
    assert.equal(findMatchingOpenBrace('{"a": 1'), -1);
    assert.equal(findMatchingOpenBrace('{"a": "unterminated}'), -1);
  });
});

describe("parseReport: happy path", () => {
  it("parses + validates a bare-JSON final message", () => {
    const msg = `{
      "status": "done",
      "summary": "Mapped the tracker layer.",
      "artefacts": ["scripts/lib/trackers/github.mjs"]
    }`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.deepEqual(errors, []);
    assert.equal(report.status, "done");
    assert.deepEqual(report.artefacts, ["scripts/lib/trackers/github.mjs"]);
  });

  it("accepts prose preceding the JSON", () => {
    const msg = `I examined the tracker layer and found nothing concerning.

Here is my report:
{"status":"done","summary":"Traced the four namespaces.","artefacts":[]}`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.deepEqual(errors, []);
    assert.equal(report.summary, "Traced the four namespaces.");
  });

  it("accepts a report with optional fields populated", () => {
    const msg = `{
      "status": "partial",
      "summary": "Found 3 findings; flagged but did not act.",
      "artefacts": ["scripts/lib/trackers/github.mjs", "scripts/lib/trackers/stub.mjs"],
      "blockers": ["Unclear whether the NotSupportedError shape is portable."],
      "nextStep": "Ask the user before acting on finding 2."
    }`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.deepEqual(errors, []);
    assert.equal(report.status, "partial");
    assert.equal(report.blockers.length, 1);
    assert.equal(report.nextStep, "Ask the user before acting on finding 2.");
  });
});

describe("parseReport: rejection cases", () => {
  it("rejects non-string messageText", () => {
    const { report, errors } = parseReport(123, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors[0].message.includes("messageText must be a string"));
  });

  it("rejects an empty message", () => {
    const { report, errors } = parseReport("   ", SCHEMA);
    assert.equal(report, null);
    assert.ok(errors[0].message.includes("empty message"));
  });

  it("rejects a message that doesn't end with '}'", () => {
    const msg = `{"status":"done","summary":"ok","artefacts":[]}

Trailing prose after JSON.`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors[0].message.includes("must end with a JSON report"));
  });

  it("rejects truncated JSON (not balanced, doesn't end with '}')", () => {
    // Truncated payload missing the closing brace + bracket. The
    // trailing-`}` check trips first, surfacing the must-end-with-
    // JSON-report error.
    const msg = `prose\n{"status": "done", "summary": "ok", "artefacts": [`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors.some((e) => /must end with a JSON report/.test(e.message)));
  });

  it("rejects JSON that closes with '}' but is internally unbalanced", () => {
    // Ends with `}` but `findMatchingOpenBrace` detects the extra
    // closing brace and returns -1.
    const msg = `prose\n{"status":"done","summary":"ok","artefacts":[]}}`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors.some((e) => /could not find a balanced JSON object/.test(e.message)));
  });

  it("rejects parse errors inside a balanced-looking block", () => {
    const msg = `prose\n{"status":"done" "missing":"comma","summary":"","artefacts":[]}`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors.some((e) => e.message.includes("failed to parse")));
  });

  it("rejects schema violations (surfaces them via Ajv error shape)", () => {
    const msg = `{"status": "weird", "summary": "ok", "artefacts": []}`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    // Ajv returns an error with path "$.status" and an enum message.
    assert.ok(errors.some((e) => e.path.includes("status")));
  });

  it("rejects a report missing required fields", () => {
    const msg = `{"status": "done", "summary": "ok"}`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors.some((e) => e.path.includes("artefacts")));
  });

  it("rejects a summary beyond the 2400-char cap", () => {
    const long = "x".repeat(2401);
    const msg = `{"status":"done","summary":${JSON.stringify(long)},"artefacts":[]}`;
    const { report, errors } = parseReport(msg, SCHEMA);
    assert.equal(report, null);
    assert.ok(errors.some((e) => e.path.includes("summary")));
  });

  it("throws synchronously when the schema arg is null (caller bug, not Soldier bug)", () => {
    assert.throws(() => parseReport("{}", null), /schema must be a plain object/);
  });
});
