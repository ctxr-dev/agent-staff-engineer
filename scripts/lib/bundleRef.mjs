// lib/bundleRef.mjs
// Render an absolute path in a form that survives being committed and
// shared across a team. The installer calls this for every bundle/skill
// path that ends up inside a generated wrapper's frontmatter or body.
//
// Three cases, in order:
//   1. abs is inside target        -> project-relative POSIX path
//   2. abs is inside $HOME         -> "~/<rest>" (POSIX)
//   3. otherwise                   -> abs (last resort, rare)
//
// A raw "/Users/alice/..." path in a committed wrapper breaks for every
// teammate whose username is not "alice". POSIX separators keep the
// rendered path portable across Windows/macOS/Linux.

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * @param {string} abs absolute path to render
 * @param {string} target absolute path to the project root
 * @returns {string} portable display form
 */
export function portableRef(abs, target) {
  if (typeof abs !== "string" || abs.length === 0) {
    throw new TypeError("portableRef: abs must be a non-empty string");
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("portableRef: target must be a non-empty string");
  }
  if (!isAbsolute(abs)) {
    throw new Error(`portableRef: abs must be absolute, got "${abs}"`);
  }
  if (!isAbsolute(target)) {
    throw new Error(`portableRef: target must be absolute, got "${target}"`);
  }

  const absResolved = resolve(abs);
  const targetResolved = resolve(target);

  // Case 1: inside target -> relative.
  const rel = relative(targetResolved, absResolved);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return toPosix(rel);
  }
  if (rel.length === 0) return ".";

  // Case 2: inside $HOME -> "~/...".
  // On macOS, both the bundle and $HOME can sit under /private/var/folders
  // (or similar) where /var is a symlink to /private/var. The installer
  // already realpath-resolves the bundle before it reaches us; do the same
  // for $HOME so the prefix check lines up. Fall back to raw homedir() if
  // the realpath call fails (e.g., HOME is unset or points at a deleted dir).
  const home = realHome();
  if (home && absResolved === home) return "~";
  if (home && absResolved.startsWith(home + sep)) {
    const rest = absResolved.slice(home.length + 1);
    return "~/" + toPosix(rest);
  }

  // Case 3: last resort.
  return toPosix(absResolved);
}

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function realHome() {
  const raw = homedir();
  if (!raw) return "";
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}
