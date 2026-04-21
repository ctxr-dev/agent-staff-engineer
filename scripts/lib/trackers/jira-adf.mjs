// lib/trackers/jira-adf.mjs
// Markdown -> Atlassian Document Format (ADF) for Jira REST v3.
//
// Jira Cloud v3 requires rich-text payloads (issue description,
// comment body, certain custom fields) as ADF JSON rather than raw
// markdown. This module converts a markdown string to a minimal valid
// ADF document, covering the subset the agent actually emits:
//
//   - paragraphs
//   - ATX headings `#` ... `######`
//   - bullet lists (`-` / `*` / `+`)
//   - ordered lists (`1.` / `2.` ...)
//   - blockquotes (`>`)
//   - fenced code blocks (```lang ... ```)
//   - thematic break (`---` / `***` / `___`)
//   - inline: bold (`**` / `__`), italic (`*` / `_`),
//     strike (`~~`), inline code (backticks), link `[text](url)`,
//     hard break (two trailing spaces before newline)
//
// Anything outside that set (tables, footnotes, HTML) is preserved as
// plain paragraph text so the payload still renders something coherent
// rather than 400-ing against the ADF schema validator.
//
// The converter is self-contained: no runtime dependency, no regex
// backtracking traps, each block type a separate pass so block-level
// behaviour is easy to unit-test.

/**
 * Convert a markdown string to a minimal valid ADF document.
 *
 * @param {string} markdown  Input; empty or all-whitespace inputs
 *   produce an empty document (valid ADF).
 * @returns {{ type: "doc", version: 1, content: object[] }}
 */
export function markdownToAdf(markdown) {
  if (typeof markdown !== "string") {
    throw new TypeError(
      `jira-adf.markdownToAdf: markdown must be a string; got ${typeof markdown}`,
    );
  }
  const blocks = parseBlocks(markdown);
  return { type: "doc", version: 1, content: blocks };
}

/**
 * Wrap a plain-text string in a single-paragraph ADF document.
 * Useful for short comments where markdown syntax is unlikely.
 *
 * @param {string} text
 * @returns {{ type: "doc", version: 1, content: object[] }}
 */
export function plainTextToAdf(text) {
  if (typeof text !== "string") {
    throw new TypeError(
      `jira-adf.plainTextToAdf: text must be a string; got ${typeof text}`,
    );
  }
  const trimmed = text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
  if (trimmed.length === 0) return { type: "doc", version: 1, content: [] };
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: trimmed }] }],
  };
}

// ── Block parser ────────────────────────────────────────────────────

function parseBlocks(input) {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip leading blank lines between blocks.
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // Fenced code block: ```[lang]
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] || null;
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      const node = {
        type: "codeBlock",
        content: buf.length > 0 ? [{ type: "text", text: buf.join("\n") }] : [],
      };
      if (language) node.attrs = { language };
      blocks.push(node);
      continue;
    }

    // Thematic break: `---` or `***` or `___` on its own line.
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    // ATX heading: `#` through `######` followed by a space.
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    // Bullet list (-, *, +). Multi-line items collapse until a blank
    // line or a non-list line breaks the group.
    if (/^\s*[-*+]\s+/.test(line)) {
      const { items, consumed } = collectListItems(lines, i, /^\s*[-*+]\s+/);
      blocks.push({
        type: "bulletList",
        content: items.map((text) => listItemNode(text)),
      });
      i += consumed;
      continue;
    }

    // Ordered list (1. 2. ...). Same collection rules.
    if (/^\s*\d+\.\s+/.test(line)) {
      const { items, consumed, firstNumber } = collectOrderedListItems(
        lines,
        i,
      );
      const node = {
        type: "orderedList",
        content: items.map((text) => listItemNode(text)),
      };
      if (firstNumber !== 1) node.attrs = { order: firstNumber };
      blocks.push(node);
      i += consumed;
      continue;
    }

    // Blockquote: one or more consecutive `> ` lines. Nested blocks
    // are rendered as paragraphs inside the quote for simplicity (the
    // agent's templates never need deeper nesting).
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const inner = buf.join("\n").trim();
      blocks.push({
        type: "blockquote",
        content: inner.length > 0
          ? [{ type: "paragraph", content: parseInline(inner) }]
          : [{ type: "paragraph", content: [] }],
      });
      continue;
    }

    // Default: paragraph. Greedy until blank line / block-break.
    const para = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim().length === 0) break;
      if (isBlockBoundary(cur)) break;
      para.push(cur);
      i++;
    }
    blocks.push({
      type: "paragraph",
      content: parseInline(para.join("\n")),
    });
  }

  return blocks;
}

function isBlockBoundary(line) {
  return (
    /^```(\S*)\s*$/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}

function collectListItems(lines, start, markerRe) {
  const items = [];
  let i = start;
  let current = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) break;
    const m = markerRe.exec(line);
    if (m) {
      if (current !== null) items.push(current);
      current = line.replace(markerRe, "").trim();
      i++;
      continue;
    }
    // Continuation of a list item (indented / wrapped line).
    if (current !== null && /^(\s{2,}|\t)/.test(line)) {
      current += "\n" + line.replace(/^(\s{2,}|\t)/, "");
      i++;
      continue;
    }
    break;
  }
  if (current !== null) items.push(current);
  return { items, consumed: i - start };
}

function collectOrderedListItems(lines, start) {
  const re = /^\s*(\d+)\.\s+(.*)$/;
  const items = [];
  let i = start;
  let current = null;
  let firstNumber = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) break;
    const m = re.exec(line);
    if (m) {
      if (firstNumber === null) firstNumber = Number(m[1]);
      if (current !== null) items.push(current);
      current = m[2].trim();
      i++;
      continue;
    }
    if (current !== null && /^(\s{2,}|\t)/.test(line)) {
      current += "\n" + line.replace(/^(\s{2,}|\t)/, "");
      i++;
      continue;
    }
    break;
  }
  if (current !== null) items.push(current);
  return { items, consumed: i - start, firstNumber: firstNumber ?? 1 };
}

function listItemNode(text) {
  // Each list item becomes `listItem > paragraph`. Multi-line items
  // keep their inline content collapsed into a single paragraph.
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: parseInline(text) }],
  };
}

// ── Inline parser ───────────────────────────────────────────────────

/**
 * Tokenise inline-level markdown into ADF text nodes with marks.
 * Supports: inline code (backticks), links `[text](url)`, strong
 * (`**`/`__`), em (`*`/`_`), strike (`~~`), hard break (two spaces
 * before a newline), and soft newlines (collapse to space).
 */
function parseInline(raw) {
  if (!raw || raw.length === 0) return [];
  // Normalise hardBreak marker first so the main tokeniser never has
  // to look across newline boundaries. Two or more trailing spaces
  // before `\n` turn into a literal hardBreak sentinel we splice back
  // in below; all other `\n` become a space. The sentinel is a
  // Unicode Private Use Area codepoint (U+E000): unambiguous,
  // non-control, never assigned, and cannot legitimately appear in
  // markdown input (spaces would collide with user text; NUL would
  // trip editors/diffs).
  const HARD_BREAK_SENTINEL = "\uE000";
  const normalised = raw
    .replace(/[ \t]{2,}\n/g, HARD_BREAK_SENTINEL)
    .replace(/\n/g, " ");
  const segments = normalised.split(HARD_BREAK_SENTINEL);
  const out = [];
  for (let s = 0; s < segments.length; s++) {
    pushInlineTokens(segments[s], [], out);
    if (s < segments.length - 1) out.push({ type: "hardBreak" });
  }
  return out;
}

function pushInlineTokens(text, marks, out) {
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      const node = { type: "text", text: buf };
      if (marks.length > 0) node.marks = marks.map(cloneMark);
      out.push(node);
      buf = "";
    }
  };
  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code: `...` (single-tick only; the agent never emits
    // double-tick escapes).
    if (rest[0] === "`") {
      const end = rest.indexOf("`", 1);
      if (end > 0) {
        flush();
        const code = rest.slice(1, end);
        out.push({
          type: "text",
          text: code,
          marks: [...marks.map(cloneMark), { type: "code" }],
        });
        i += end + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (rest[0] === "[") {
      const match = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (match) {
        flush();
        const linkMarks = [...marks, { type: "link", attrs: { href: match[2] } }];
        pushInlineTokens(match[1], linkMarks, out);
        i += match[0].length;
        continue;
      }
    }

    // Strong: **...** or __...__
    if ((rest.startsWith("**") || rest.startsWith("__"))) {
      const delim = rest.slice(0, 2);
      const end = findClosingDelim(rest, delim, 2);
      if (end > 2) {
        flush();
        const inner = rest.slice(2, end);
        pushInlineTokens(inner, [...marks, { type: "strong" }], out);
        i += end + 2;
        continue;
      }
    }

    // Em: *...* or _..._  (single char; avoid matching `**`)
    if ((rest[0] === "*" || rest[0] === "_") && rest[1] !== rest[0]) {
      const delim = rest[0];
      const end = findClosingDelim(rest, delim, 1);
      if (end > 1) {
        flush();
        const inner = rest.slice(1, end);
        pushInlineTokens(inner, [...marks, { type: "em" }], out);
        i += end + 1;
        continue;
      }
    }

    // Strike: ~~...~~
    if (rest.startsWith("~~")) {
      const end = findClosingDelim(rest, "~~", 2);
      if (end > 2) {
        flush();
        const inner = rest.slice(2, end);
        pushInlineTokens(inner, [...marks, { type: "strike" }], out);
        i += end + 2;
        continue;
      }
    }

    buf += rest[0];
    i++;
  }
  flush();
}

// Find the next raw occurrence of `delim` after `start`. Returns the
// index, or -1 if absent. Intentionally simple: we only match against
// same-character delimiters (`*`, `_`, `**`, `__`, `~~`, `` ` ``) and
// this helper does NOT apply word-boundary checks. Callers accept the
// approximation because the agent's own templates emit well-formed
// markdown (no intra-word underscores / asterisks); user-written
// bodies pass through the same path, and we prefer a misparse that
// still produces valid ADF over a heavier word-aware tokeniser.
function findClosingDelim(str, delim, start) {
  let i = start;
  while (i <= str.length - delim.length) {
    if (str.slice(i, i + delim.length) === delim) return i;
    i++;
  }
  return -1;
}

function cloneMark(m) {
  if (m.attrs) return { type: m.type, attrs: { ...m.attrs } };
  return { type: m.type };
}
