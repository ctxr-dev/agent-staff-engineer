// lib/argv.mjs
// Minimal flags parser for agent-staff-engineer scripts. Zero npm deps.
// Recognises three forms:
//   --flag          -> flag: true
//   --flag=value    -> flag: value
//   --flag value    -> flag: value (when next token is not another flag)
// Everything that does not start with "--" is a positional arg.

const isFlag = (s) => typeof s === "string" && s.startsWith("--");

/**
 * Parse argv (typically process.argv.slice(2)).
 * @param {string[]} argv
 * @param {object} options
 * @param {Set<string>} [options.booleans] flags that must not consume the next token as a value
 * @returns {{ flags: Record<string, string | boolean>, positionals: string[] }}
 */
export function parseArgv(argv, options = {}) {
  const booleans = options.booleans ?? new Set();
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!isFlag(tok)) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      const k = tok.slice(2, eq);
      const v = tok.slice(eq + 1);
      if (v === "") {
        throw new Error(`flag --${k}= has an empty value; use --${k}=<value> or omit the =`);
      }
      flags[k] = v;
      continue;
    }
    const k = tok.slice(2);
    if (booleans.has(k)) {
      flags[k] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !isFlag(next)) {
      flags[k] = next;
      i++;
    } else {
      flags[k] = true;
    }
  }

  return { flags, positionals };
}

/** Resolve boolean flag, treating string values like "true"/"false" sanely. */
export function boolFlag(flags, name, defaultValue = false) {
  if (!(name in flags)) return defaultValue;
  const v = flags[name];
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "" || s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return Boolean(v);
}

/** Require a string flag; throw if missing or true-only. */
export function requireStringFlag(flags, name) {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return v;
}
