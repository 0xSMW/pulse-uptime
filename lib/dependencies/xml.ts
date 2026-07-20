import "server-only";

// Safe, bounded RSS/Atom reader for the incident-feed adapters. It is a
// hand-rolled scanner rather than a general XML tree parser, deliberately, so
// the whole attack surface is the small set of tags below and there is no DTD
// engine, no entity table, and no external-resource resolution to disable in
// the first place. Package has no XML dependency and the spec prefers a small
// bounded parser to a new one, so this stays hand-rolled.
//
// Hardening, matching Docs/Specs/DEPENDENCY-MONITORING.md "Security and failure
// containment":
//   - DTDs and external entities are disabled. Any `<!ENTITY` declaration is
//     rejected outright, and no `&name;` outside the five XML predefined
//     entities is ever expanded, so an external-entity reference stays inert
//     literal text.
//   - Entity expansion is bounded. Decoding is a single non-recursive pass, so
//     a billion-laughs style bomb cannot grow: undefined custom entities never
//     match and never re-expand.
//   - Oversized input is rejected before any scanning, and every field is
//     length capped, so a hostile feed cannot exhaust memory.

export class XmlParseError extends Error {
  constructor(
    readonly code: "OVERSIZED" | "DTD_FORBIDDEN" | "MALFORMED",
    message: string,
  ) {
    super(message);
    this.name = "XmlParseError";
  }
}

/** One normalized feed item. Every text field is decoded to bounded plain text with markup stripped, never raw markup. */
export interface XmlFeedItem {
  guid: string | null;
  title: string | null;
  description: string | null;
  link: string | null;
  pubDate: string | null;
  categories: string[];
}

export interface ParseFeedOptions {
  /** Reject input whose UTF-8 byte length exceeds this. Default 512 KB, matching the feed body cap. */
  maxInputBytes?: number;
  /** Stop after this many item/entry blocks. Default 200. */
  maxItems?: number;
  /** Truncate each text field to this many characters. Default 4096, matching the spec's 4 KB per-update cap. */
  maxTextLength?: number;
  /** Keep at most this many categories per item. Default 32. */
  maxCategories?: number;
}

const DEFAULTS = {
  maxInputBytes: 512 * 1024,
  maxItems: 200,
  maxTextLength: 4096,
  maxCategories: 32,
} as const;

/**
 * Parses an RSS or Atom document into bounded plain-text items. Throws
 * XmlParseError on oversized input or a DTD/entity declaration. Never resolves
 * external resources and never expands custom entities.
 */
export function parseFeed(xml: string, options: ParseFeedOptions = {}): XmlFeedItem[] {
  const maxInputBytes = options.maxInputBytes ?? DEFAULTS.maxInputBytes;
  const maxItems = options.maxItems ?? DEFAULTS.maxItems;
  const maxTextLength = options.maxTextLength ?? DEFAULTS.maxTextLength;
  const maxCategories = options.maxCategories ?? DEFAULTS.maxCategories;

  if (Buffer.byteLength(xml, "utf8") > maxInputBytes) {
    throw new XmlParseError("OVERSIZED", `feed exceeds ${maxInputBytes} bytes`);
  }
  // A DTD that declares entities is the vector for both billion-laughs and
  // external-entity attacks, so its mere presence is refused rather than
  // parsed and ignored. External DTD subsets (SYSTEM/PUBLIC) are refused for
  // the same reason.
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\b(?:SYSTEM|PUBLIC)\b/i.test(xml)) {
    throw new XmlParseError("DTD_FORBIDDEN", "feed declares a DTD or entities, which are disabled");
  }

  // Comments and processing instructions are dropped whole so their contents
  // never leak into a text field. The DOCTYPE line (without entity subset,
  // already refused above) is dropped too.
  const cleaned = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");

  const blocks = extractBlocks(cleaned, ["item", "entry"], maxItems);
  return blocks.map((block) => ({
    guid: firstTagText(block, ["guid", "id"], maxTextLength),
    title: firstTagText(block, ["title"], maxTextLength),
    description: firstTagText(block, ["description", "summary", "content"], maxTextLength),
    link: extractLink(block, maxTextLength),
    pubDate: firstTagText(block, ["pubdate", "updated", "published"], maxTextLength),
    categories: extractCategories(block, maxCategories, maxTextLength),
  }));
}

/** Slices out the inner content of each `<tag ...>...</tag>` for any of the given tags, capped at maxItems and scanning linearly so a pathological feed cannot cause quadratic blowup. */
function extractBlocks(xml: string, tagNames: readonly string[], maxItems: number): string[] {
  const blocks: string[] = [];
  const lower = xml.toLowerCase();
  let cursor = 0;
  while (blocks.length < maxItems) {
    let start = -1;
    let matchedTag = "";
    for (const tag of tagNames) {
      const at = lower.indexOf(`<${tag}`, cursor);
      if (at !== -1 && (start === -1 || at < start)) {
        // Confirm a real tag boundary, so `<items>` never matches `item`.
        const boundary = xml[at + tag.length + 1];
        if (boundary === undefined || /[\s>/]/.test(boundary)) {
          start = at;
          matchedTag = tag;
        }
      }
    }
    if (start === -1) break;

    const openEnd = xml.indexOf(">", start);
    if (openEnd === -1) break;
    // A self-closing `<entry/>` carries no content, skip past it.
    if (xml[openEnd - 1] === "/") {
      cursor = openEnd + 1;
      continue;
    }
    const closeAt = lower.indexOf(`</${matchedTag}>`, openEnd);
    if (closeAt === -1) break;
    blocks.push(xml.slice(openEnd + 1, closeAt));
    cursor = closeAt + matchedTag.length + 3;
  }
  return blocks;
}

/** Returns the decoded text of the first present tag among the candidates, or null when none is present. */
function firstTagText(block: string, tagNames: readonly string[], maxTextLength: number): string | null {
  for (const tag of tagNames) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
    if (match) {
      const text = decodeText(match[1], maxTextLength);
      if (text) return text;
    }
  }
  return null;
}

/** RSS carries the link as element text, Atom as a self-closing `<link href=...>`. Element text wins when present, else the href attribute. */
function extractLink(block: string, maxTextLength: number): string | null {
  const textMatch = /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i.exec(block);
  const text = textMatch ? decodeText(textMatch[1], maxTextLength) : "";
  if (text) return text;
  const hrefMatch = /<link\b[^>]*\bhref\s*=\s*"([^"]*)"/i.exec(block);
  if (hrefMatch) {
    const href = decodeText(hrefMatch[1], maxTextLength);
    if (href) return href;
  }
  return null;
}

/** Collects RSS `<category>text</category>` and Atom `<category term="...">` values, deduped and capped. */
function extractCategories(block: string, maxCategories: number, maxTextLength: number): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    if (value && !seen.has(value) && found.length < maxCategories) {
      seen.add(value);
      found.push(value);
    }
  };

  const textRe = /<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi;
  for (let match = textRe.exec(block); match && found.length < maxCategories; match = textRe.exec(block)) {
    push(decodeText(match[1], maxTextLength));
  }
  const termRe = /<category\b[^>]*\bterm\s*=\s*"([^"]*)"/gi;
  for (let match = termRe.exec(block); match && found.length < maxCategories; match = termRe.exec(block)) {
    push(decodeText(match[1], maxTextLength));
  }
  return found;
}

/** Unwraps CDATA, strips all remaining markup, decodes the five predefined and numeric entities in one pass, collapses whitespace, and truncates. */
function decodeText(raw: string, maxTextLength: number): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const withoutTags = withoutCdata.replace(/<[^>]*>/g, "");
  const decoded = decodeEntities(withoutTags);
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return collapsed.length > maxTextLength ? collapsed.slice(0, maxTextLength) : collapsed;
}

/**
 * Decodes only the five XML predefined entities and numeric character
 * references, in a single non-recursive pass. An undefined custom entity is
 * left as literal text, which is what neutralizes both external-entity and
 * billion-laughs payloads: they never resolve and the result never re-expands.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    switch (lower) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      default: {
        const code = lower[1] === "x" ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
  });
}
