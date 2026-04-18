// Shared test helper: seed a minimal @ctxr/skill-llm-wiki install so
// install.mjs's dep check passes in tests that aren't exercising the
// dep-check logic itself. The stub ships only a SKILL.md at the expected
// kit path; tests that exercise wiki operations (build/validate/etc.)
// compose their own richer fixtures on top.
//
// `layout` picks which kit-supported destination to simulate:
//   "claude-skills" (default): <base>/.claude/skills/ctxr-skill-llm-wiki/
//   "agents-skills":           <base>/.agents/skills/ctxr-skill-llm-wiki/
// See @ctxr/kit src/lib/types.js ARTIFACT_TYPES.skill for the canonical list.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LAYOUTS = {
  "claude-skills": [".claude", "skills"],
  "agents-skills": [".agents", "skills"],
};

/**
 * Creates a stub @ctxr/skill-llm-wiki at the configured layout under `base`.
 * `base` is the target project root for project-local layouts, or a HOME
 * override for user-global testing.
 */
export async function seedWikiSkillStub(base, layout = "claude-skills") {
  const parts = LAYOUTS[layout];
  if (!parts) throw new Error(`seedWikiSkillStub: unknown layout "${layout}"`);
  const dir = join(base, ...parts, "ctxr-skill-llm-wiki");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: llm-wiki",
      "description: stub of @ctxr/skill-llm-wiki for tests",
      "---",
      "",
      "Test stub; not the real skill body.",
      "",
    ].join("\n"),
  );
}
