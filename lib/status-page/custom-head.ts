import type { DefaultTreeAdapterMap } from "parse5"
import { html as parse5Html, parseFragment } from "parse5"
import { createElement, Fragment, type ReactNode } from "react"

/**
 * Restricted custom head fragment for the public status page.
 *
 * Field name stays `customHead` for API compatibility. Only `meta` and
 * icon-related `link` elements are allowed. Parsed on write (reject) and
 * again on render (drop + warn). Never injected as raw HTML.
 */

type TreeElement = DefaultTreeAdapterMap["element"]
type TreeChild = DefaultTreeAdapterMap["childNode"]
type TreeAttribute = TreeElement["attrs"][number]

export type CustomHeadElement =
  | { tag: "meta"; attrs: Record<string, string> }
  | { tag: "link"; attrs: Record<string, string> }

export type CustomHeadParseResult =
  | { ok: true; elements: CustomHeadElement[] }
  | { ok: false; message: string }

const HTML_NS = parse5Html.NS.HTML

const META_ATTRS = new Set(["name", "property", "content", "charset"])
const LINK_ATTRS = new Set(["rel", "href", "type", "sizes", "media", "color"])

const ICON_RELS = new Set([
  "icon",
  "shortcut icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
])

function fail(message: string): CustomHeadParseResult {
  return { ok: false, message }
}

/** Strip ASCII whitespace and controls the way browsers do before scheme checks. */
function compactUrl(value: string): string {
  let compact = ""
  for (const char of value) {
    if (char.charCodeAt(0) > 0x20) {
      compact += char
    }
  }
  return compact
}

/**
 * Site-relative paths (`/…`, not `//…`) or absolute HTTPS only.
 * Rejects protocol-relative, javascript:, data:, and other schemes.
 */
export function isSafeCustomHeadHref(value: string): boolean {
  const compact = compactUrl(value)
  if (!compact) {
    return false
  }
  if (compact.startsWith("//")) {
    return false
  }
  if (compact.startsWith("/")) {
    // Backslashes can be treated as path separators in some agents.
    return !compact.includes("\\")
  }

  let parsed: URL
  try {
    parsed = new URL(compact)
  } catch {
    return false
  }
  return parsed.protocol === "https:"
}

function hasNamespaceTrick(attr: TreeAttribute): boolean {
  if (attr.namespace || attr.prefix) {
    return true
  }
  const name = attr.name
  return name.includes(":") || name === "xmlns" || name.startsWith("xmlns:")
}

function isEventHandlerAttr(name: string): boolean {
  return name.length >= 3 && name.startsWith("on")
}

function attrsToRecord(
  attrs: readonly TreeAttribute[],
  allowed: ReadonlySet<string>
):
  | { ok: true; attrs: Record<string, string> }
  | { ok: false; message: string } {
  const record: Record<string, string> = {}
  for (const attr of attrs) {
    if (hasNamespaceTrick(attr)) {
      return { ok: false, message: "Namespaced attributes are not allowed" }
    }
    if (isEventHandlerAttr(attr.name)) {
      return { ok: false, message: "Event handler attributes are not allowed" }
    }
    if (attr.name === "srcdoc") {
      return { ok: false, message: "srcdoc is not allowed" }
    }
    if (attr.name === "http-equiv") {
      return { ok: false, message: "meta http-equiv is not allowed" }
    }
    if (!allowed.has(attr.name)) {
      return {
        ok: false,
        message: `Attribute "${attr.name}" is not allowed`,
      }
    }
    if (Object.hasOwn(record, attr.name)) {
      return { ok: false, message: `Duplicate attribute "${attr.name}"` }
    }
    record[attr.name] = attr.value
  }
  return { ok: true, attrs: record }
}

function normalizeIconRel(rel: string): string {
  return rel.trim().toLowerCase().replace(/\s+/g, " ")
}

function parseMeta(element: TreeElement): CustomHeadParseResult {
  if (element.childNodes.length > 0) {
    return fail("meta elements must be empty")
  }
  const parsed = attrsToRecord(element.attrs, META_ATTRS)
  if (!parsed.ok) {
    return fail(parsed.message)
  }
  const { attrs } = parsed
  const charset = attrs.charset
  if (charset !== undefined && charset.trim().toLowerCase() !== "utf-8") {
    return fail("meta charset must be utf-8")
  }
  if (
    !(
      Object.hasOwn(attrs, "charset") ||
      Object.hasOwn(attrs, "name") ||
      Object.hasOwn(attrs, "property")
    )
  ) {
    return fail("meta requires name, property, or charset")
  }
  return { ok: true, elements: [{ tag: "meta", attrs }] }
}

function parseLink(element: TreeElement): CustomHeadParseResult {
  if (element.childNodes.length > 0) {
    return fail("link elements must be empty")
  }
  const parsed = attrsToRecord(element.attrs, LINK_ATTRS)
  if (!parsed.ok) {
    return fail(parsed.message)
  }
  const { attrs } = parsed
  const rel = attrs.rel
  if (!rel?.trim()) {
    return fail("link requires an icon rel")
  }
  if (!ICON_RELS.has(normalizeIconRel(rel))) {
    return fail("link rel must be an icon relation")
  }
  const href = attrs.href
  if (!href?.trim()) {
    return fail("link requires an href")
  }
  if (!isSafeCustomHeadHref(href)) {
    return fail("link href must be site-relative or HTTPS")
  }
  return { ok: true, elements: [{ tag: "link", attrs }] }
}

function parseElement(element: TreeElement): CustomHeadParseResult {
  if (element.namespaceURI !== HTML_NS) {
    return fail("Only HTML elements are allowed")
  }
  // tagName is a free string on the element adapter; compare as plain text.
  const tag = String(element.tagName)
  if (tag === "meta") {
    return parseMeta(element)
  }
  if (tag === "link") {
    return parseLink(element)
  }
  if (tag === "script") {
    return fail("script elements are not allowed")
  }
  if (tag === "style") {
    return fail("style elements are not allowed")
  }
  if (tag === "base") {
    return fail("base elements are not allowed")
  }
  if (tag === "iframe" || tag === "frame" || tag === "frameset") {
    return fail("frame elements are not allowed")
  }
  if (tag === "embed") {
    return fail("embed elements are not allowed")
  }
  if (tag === "object") {
    return fail("object elements are not allowed")
  }
  return fail(`Element <${tag}> is not allowed`)
}

function parseChild(node: TreeChild): CustomHeadParseResult {
  if (node.nodeName === "#text" && "value" in node) {
    if (node.value.trim() === "") {
      return { ok: true, elements: [] }
    }
    return fail("Text content is not allowed")
  }
  if (node.nodeName === "#comment") {
    return fail("HTML comments are not allowed")
  }
  if (node.nodeName === "#documentType") {
    return fail("Doctype is not allowed")
  }
  // Template and element share Element shape; treat both via tagName.
  if ("tagName" in node) {
    return parseElement(node)
  }
  return fail("Unsupported node in custom head")
}

/**
 * Parse and validate a custom head fragment. Returns structured elements on
 * success, or a pithy validation message on failure.
 */
export function parseCustomHead(input: string): CustomHeadParseResult {
  let fragment: DefaultTreeAdapterMap["documentFragment"]
  try {
    fragment = parseFragment(input)
  } catch {
    return fail("Custom head could not be parsed")
  }

  const elements: CustomHeadElement[] = []
  for (const child of fragment.childNodes) {
    const result = parseChild(child)
    if (!result.ok) {
      return result
    }
    elements.push(...result.elements)
  }
  return { ok: true, elements }
}

function toReactProps(attrs: Record<string, string>): Record<string, string> {
  const props: Record<string, string> = {}
  for (const [name, value] of Object.entries(attrs)) {
    // React expects the DOM property form for charset.
    props[name === "charset" ? "charSet" : name] = value
  }
  return props
}

/** Build React elements from a validated element list. No raw HTML. */
export function customHeadElementsToReact(
  elements: readonly CustomHeadElement[]
): ReactNode {
  if (elements.length === 0) {
    return null
  }
  return createElement(
    Fragment,
    null,
    ...elements.map((element, index) =>
      createElement(element.tag, {
        key: index,
        ...toReactProps(element.attrs),
      })
    )
  )
}

/**
 * Defense-in-depth render path. Re-parses the stored fragment. On failure,
 * emits a structured warning without the unsafe value and renders nothing.
 */
export function renderSafeCustomHead(
  input: string | null | undefined
): ReactNode {
  if (!input) {
    return null
  }
  const result = parseCustomHead(input)
  if (!result.ok) {
    console.warn(
      JSON.stringify({
        event: "status_page.custom_head_rejected",
        reason: result.message,
      })
    )
    return null
  }
  if (result.elements.length === 0) {
    return null
  }
  return createElement(
    "div",
    { "data-status-custom-head": true },
    customHeadElementsToReact(result.elements)
  )
}
