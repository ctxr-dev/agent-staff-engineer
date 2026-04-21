// lib/orchestration/report.mjs
// Parse + validate a Soldier report. The Agent tool returns a single
// message; this module parses the trailing JSON object and validates
// it against schemas/soldier-report.schema.json.
//
// No I/O. No runtime deps beyond the bundle's existing Ajv validator.
// Pure function over (messageText, schema) -> {report, errors}.

import { validate } from "../schema.mjs";

/**
 * Parse a Soldier's final message. The Captain passes the raw return
 * string (the Agent tool's final assistant message) and the loaded
 * schema (from schemas/soldier-report.schema.json).
 *
 * Returns `{ report, errors }`:
 *   - report: the parsed + validated object, or null on any failure.
 *   - errors: array of { path, message } describing what went wrong.
 *     Shape matches scripts/lib/schema.mjs#validate; a trailing-text
 *     issue surfaces as `{ path: "$", message: "…" }` so callers can
 *     reuse their existing error-printing code.
 *
 * Rejection cases (errors non-empty):
 *   1. Message doesn't end with `}` (Soldier emitted prose after JSON).
 *   2. Trailing JSON block fails to parse.
 *   3. Parsed object fails soldier-report schema validation.
 *   4. Message contains a JSON block earlier AND trailing text.
 *
 * The function refuses to auto-extract a JSON object from the middle
 * of a Soldier's message. Per the briefing contract, the JSON report
 * must be the FINAL message. Loose extraction would let a Soldier's
 * "here's what I considered" prose slip past validation.
 */
export function parseReport(messageText, schema) {
  if (typeof messageText !== "string") {
    return {
      report: null,
      errors: [
        { path: "$", message: `parseReport: messageText must be a string; got ${typeof messageText}` },
      ],
    };
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(
      `parseReport: schema must be a plain object; got ${JSON.stringify(schema)}`,
    );
  }
  const trimmed = messageText.trim();
  if (trimmed.length === 0) {
    return {
      report: null,
      errors: [{ path: "$", message: "parseReport: Soldier returned an empty message" }],
    };
  }
  // Find the LAST top-level JSON object in the text: walk backwards
  // from the last `}`, matching braces. Refuses to match if the
  // trailing `}` doesn't close a balanced object, or if there's
  // non-whitespace text after the closing brace.
  if (trimmed[trimmed.length - 1] !== "}") {
    return {
      report: null,
      errors: [
        {
          path: "$",
          message:
            "parseReport: Soldier's final message must end with a JSON report (per the briefing contract). Last character is not '}'.",
        },
      ],
    };
  }
  const start = findMatchingOpenBrace(trimmed);
  if (start === -1) {
    return {
      report: null,
      errors: [
        { path: "$", message: "parseReport: could not find a balanced JSON object at end of message" },
      ],
    };
  }
  const jsonText = trimmed.slice(start);
  // Everything BEFORE the JSON is allowed (prose the Soldier wrote
  // while working); everything AFTER the JSON must be absent or
  // whitespace. The trailing-`}` + findMatchingOpenBrace guarantee
  // the JSON is the terminal element, so there's nothing else to
  // check on the tail.
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      report: null,
      errors: [
        {
          path: "$",
          message: `parseReport: trailing JSON failed to parse: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const { ok, errors } = validate(schema, parsed);
  if (!ok) {
    return { report: null, errors };
  }
  return { report: parsed, errors: [] };
}

/**
 * Walk backwards from the final `}` to find the matching `{`, respecting
 * string literals (so a `{` or `}` inside a JSON string doesn't throw
 * the counter off). Returns the index of the matching `{` or -1 on
 * unbalanced input. Exported for testing.
 */
export function findMatchingOpenBrace(text) {
  if (text.length === 0 || text[text.length - 1] !== "}") return -1;
  let depth = 0;
  let inString = false;
  // Walk forwards, track brace depth while ignoring braces inside
  // strings. Record every index where depth drops to 0 after opening;
  // the LAST such range's opening brace is our start. Also track
  // the earliest opening brace that closes at the final position.
  let lastStart = -1;
  let currentStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip escaped character
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) currentStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        lastStart = currentStart;
        currentStart = -1;
      } else if (depth < 0) {
        return -1;
      }
    }
  }
  if (depth !== 0 || inString) return -1;
  // The final `}` must have closed a top-level object. `lastStart`
  // points at that object's opening `{`.
  return lastStart;
}
