import "server-only"

/**
 * Restricted markdown renderer for content shown to unauthenticated visitors
 * (status-page announcements, status-report update bodies).
 *
 * Escape-first architecture: every HTML special character is escaped before any
 * markdown transformation runs, so transformations only ever operate on inert
 * text and emit a fixed whitelist of tags: <p>, <strong>, <em>, <code>, <a>, <br>.
 *
 * Supported syntax: paragraphs (blank-line separated), **bold**, *italic*,
 * `inline code`, [links](https://...), and line breaks within paragraphs.
 * No raw HTML, images, headings, lists, or autolinks.
 */

/** Inputs longer than this (UTF-16 code units) are truncated before processing. */
const MAX_INPUT_LENGTH = 16 * 1024

const ALLOWED_SCHEMES = ["http:", "https:", "mailto:"]

/** Placeholder sentinel for already-rendered spans. NUL is stripped from input first. */
const TOKEN = "\u0000"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Validates a link destination (already HTML-escaped). Browsers strip ASCII
 * whitespace and control characters before parsing the scheme, so we do the
 * same before checking it: "java\nscript:" cannot sneak through. Returns the
 * compacted URL when the scheme is allowed, or null to render as plain text.
 */
function sanitizeUrl(escapedUrl: string): string | null {
  let compact = ""
  for (const char of escapedUrl) {
    if (char.charCodeAt(0) > 0x20) {
      compact += char
    }
  }
  const lower = compact.toLowerCase()
  return ALLOWED_SCHEMES.some((scheme) => lower.startsWith(scheme))
    ? compact
    : null
}

type Stash = (html: string) => string

/** Replaces `code` spans with placeholder tokens so later passes skip them. */
function extractCodeSpans(text: string, stash: Stash): string {
  let out = ""
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf("`", cursor)
    if (open === -1) {
      break
    }
    const close = text.indexOf("`", open + 1)
    if (close === -1) {
      break
    }
    const content = text.slice(open + 1, close)
    out += text.slice(cursor, open)
    out += content.length > 0 ? stash(`<code>${content}</code>`) : "``"
    cursor = close + 1
  }
  return out + text.slice(cursor)
}

/** Replaces [label](url) with anchor tokens. Disallowed URLs stay plain text. */
function extractLinks(text: string, stash: Stash): string {
  let out = ""
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf("[", cursor)
    if (open === -1) {
      break
    }
    const closeBracket = text.indexOf("]", open + 1)
    const closeParen =
      closeBracket === -1 ? -1 : text.indexOf(")", closeBracket + 2)
    const label = closeBracket === -1 ? "" : text.slice(open + 1, closeBracket)
    const url =
      closeBracket !== -1 && text[closeBracket + 1] === "(" && closeParen !== -1
        ? sanitizeUrl(text.slice(closeBracket + 2, closeParen))
        : null
    const isImageSyntax = open > 0 && text[open - 1] === "!"
    if (url === null || label.length === 0 || isImageSyntax) {
      out += text.slice(cursor, open + 1)
      cursor = open + 1
      continue
    }
    out += text.slice(cursor, open)
    out += stash(
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${applyEmphasis(label)}</a>`
    )
    cursor = closeParen + 1
  }
  return out + text.slice(cursor)
}

/** Bold before italic. [^*]+ cannot backtrack catastrophically. */
function applyEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
}

function renderParagraph(escaped: string): string {
  const tokens: string[] = []
  const stash: Stash = (html) => `${TOKEN}${tokens.push(html) - 1}${TOKEN}`

  let text = extractCodeSpans(escaped, stash)
  text = extractLinks(text, stash)
  text = applyEmphasis(text)
  text = text.replace(/\n/g, "<br>\n")
  // A link label may itself contain a code-span token, so restore until no
  // sentinels remain (tokens only reference earlier tokens, depth is bounded).
  while (text.includes(TOKEN)) {
    text = text.replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is the internal sentinel that delimits stashed tokens
      /\u0000(\d+)\u0000/g,
      (_, index: string) => tokens[Number(index)]!
    )
  }
  return text
}

export function renderRestrictedMarkdown(markdown: string): string {
  const bounded =
    markdown.length > MAX_INPUT_LENGTH
      ? markdown.slice(0, MAX_INPUT_LENGTH)
      : markdown
  const normalized = bounded.replace(/\r\n?/g, "\n").replaceAll(TOKEN, "")
  const escaped = escapeHtml(normalized)
  return escaped
    .split(/\n(?:[\t ]*\n)+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${renderParagraph(paragraph)}</p>`)
    .join("\n")
}
