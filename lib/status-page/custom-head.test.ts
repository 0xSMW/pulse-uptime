import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  customHeadElementsToReact,
  isSafeCustomHeadHref,
  parseCustomHead,
  renderSafeCustomHead,
} from "./custom-head"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("isSafeCustomHeadHref", () => {
  it("accepts site-relative paths and HTTPS URLs", () => {
    expect(isSafeCustomHeadHref("/favicon.ico")).toBe(true)
    expect(isSafeCustomHeadHref("/icons/a.png")).toBe(true)
    expect(isSafeCustomHeadHref("https://cdn.example/icon.png")).toBe(true)
  })

  it("rejects protocol-relative, non-HTTPS, and script schemes", () => {
    expect(isSafeCustomHeadHref("//evil.example/x")).toBe(false)
    expect(isSafeCustomHeadHref("http://example.com/x")).toBe(false)
    expect(isSafeCustomHeadHref("javascript:alert(1)")).toBe(false)
    expect(isSafeCustomHeadHref("data:image/svg+xml,<svg>")).toBe(false)
    expect(isSafeCustomHeadHref("  javascript:alert(1)")).toBe(false)
    expect(isSafeCustomHeadHref("java\tscript:alert(1)")).toBe(false)
  })
})

describe("parseCustomHead", () => {
  it("accepts safe Open Graph metadata", () => {
    const result = parseCustomHead(
      '<meta property="og:title" content="Acme Status"><meta property="og:description" content="All systems">'
    )
    expect(result).toEqual({
      ok: true,
      elements: [
        {
          tag: "meta",
          attrs: { property: "og:title", content: "Acme Status" },
        },
        {
          tag: "meta",
          attrs: { property: "og:description", content: "All systems" },
        },
      ],
    })
  })

  it("accepts safe icon links (site-relative and HTTPS)", () => {
    const result = parseCustomHead(
      '<link rel="icon" href="/favicon.ico" type="image/x-icon"><link rel="apple-touch-icon" href="https://cdn.example/icon.png" sizes="180x180"><link rel="mask-icon" href="/mask.svg" color="#000">'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.elements).toHaveLength(3)
      expect(result.elements[0]).toMatchObject({
        tag: "link",
        attrs: { rel: "icon", href: "/favicon.ico" },
      })
    }
  })

  it("accepts mixed-case tags and attributes", () => {
    const result = parseCustomHead(
      '<META NAME="robots" CONTENT="noindex"><LINK REL="ICON" HREF="/f.ico">'
    )
    expect(result).toEqual({
      ok: true,
      elements: [
        { tag: "meta", attrs: { name: "robots", content: "noindex" } },
        { tag: "link", attrs: { rel: "ICON", href: "/f.ico" } },
      ],
    })
  })

  it("accepts utf-8 charset meta", () => {
    expect(parseCustomHead('<meta charset="utf-8">').ok).toBe(true)
    expect(parseCustomHead('<meta charset="UTF-8">').ok).toBe(true)
    expect(parseCustomHead('<meta charset="iso-8859-1">').ok).toBe(false)
  })

  it("rejects script tags", () => {
    const result = parseCustomHead("<script>alert(1)</script>")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message.toLowerCase()).toContain("script")
    }
  })

  it("rejects script mixed with safe meta", () => {
    const result = parseCustomHead(
      '<meta name="robots" content="noindex"><script src="//evil"></script>'
    )
    expect(result.ok).toBe(false)
  })

  it("rejects event handler attributes", () => {
    expect(
      parseCustomHead('<meta name="x" content="y" onload="alert(1)">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="/x" onerror="alert(1)">').ok
    ).toBe(false)
  })

  it("rejects encoded and spaced javascript: protocol tricks on href", () => {
    expect(
      parseCustomHead('<link rel="icon" href="&#x6a;avascript:alert(1)">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="  javascript:alert(1)">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="java\tscript:alert(1)">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="data:text/html,x">').ok
    ).toBe(false)
  })

  it("rejects meta http-equiv=refresh", () => {
    const result = parseCustomHead(
      '<meta http-equiv="refresh" content="0;url=//evil">'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message.toLowerCase()).toContain("http-equiv")
    }
  })

  it("rejects base, style, frames, embeds, and objects", () => {
    expect(parseCustomHead('<base href="https://evil.example">').ok).toBe(false)
    expect(parseCustomHead("<style>body{}</style>").ok).toBe(false)
    expect(parseCustomHead('<iframe src="https://x"></iframe>').ok).toBe(false)
    expect(parseCustomHead('<embed src="https://x">').ok).toBe(false)
    expect(parseCustomHead('<object data="https://x"></object>').ok).toBe(false)
  })

  it("rejects malformed nesting and non-allowed wrappers", () => {
    expect(parseCustomHead('<p><meta name="x" content="y"></p>').ok).toBe(false)
    expect(parseCustomHead('<div><link rel="icon" href="/x"></div>').ok).toBe(
      false
    )
    expect(parseCustomHead("<svg><script>alert(1)</script></svg>").ok).toBe(
      false
    )
  })

  it("rejects stylesheet and other non-icon link rels", () => {
    expect(parseCustomHead('<link rel="stylesheet" href="/x.css">').ok).toBe(
      false
    )
    expect(
      parseCustomHead('<link rel="preload" href="/x.js" as="script">').ok
    ).toBe(false)
  })

  it("rejects protocol-relative icon hrefs and HTTP", () => {
    expect(
      parseCustomHead('<link rel="icon" href="//evil.example/x">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="http://example.com/x">').ok
    ).toBe(false)
  })

  it("rejects namespace tricks and unknown attributes", () => {
    expect(
      parseCustomHead('<meta name="x" content="y" xmlns:x="http://evil">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="/ok" crossorigin="anonymous">').ok
    ).toBe(false)
    expect(
      parseCustomHead('<link rel="icon" href="/x" srcdoc="evil">').ok
    ).toBe(false)
  })

  it("rejects non-whitespace text and comments", () => {
    expect(parseCustomHead("text meta").ok).toBe(false)
    expect(
      parseCustomHead('<!-- comment --><meta name="x" content="y">').ok
    ).toBe(false)
  })

  it("allows surrounding whitespace-only text", () => {
    expect(
      parseCustomHead('   <meta name="robots" content="noindex">  ').ok
    ).toBe(true)
  })

  it("accepts an empty fragment", () => {
    expect(parseCustomHead("")).toEqual({ ok: true, elements: [] })
    expect(parseCustomHead("   ")).toEqual({ ok: true, elements: [] })
  })
})

describe("renderSafeCustomHead", () => {
  it("renders safe meta and link as React elements without raw HTML", () => {
    const node = renderSafeCustomHead(
      '<meta property="og:title" content="Hi"><link rel="icon" href="/f.ico">'
    )
    const html = renderToStaticMarkup(createElement(FragmentWrap, null, node))
    expect(html).toContain('data-status-custom-head="true"')
    expect(html).toContain('<meta property="og:title" content="Hi"/>')
    expect(html).toContain('<link rel="icon" href="/f.ico"/>')
    expect(html).not.toContain("dangerouslySetInnerHTML")
  })

  it("cannot create a script node or inline event attribute from unsafe input", () => {
    const payloads = [
      "<script>alert(1)</script>",
      '<meta name="x" content="y" onload="alert(1)">',
      "<img src=x onerror=alert(1)>",
      '<link rel="icon" href="/x" onerror="alert(1)">',
      "<svg><script>alert(1)</script></svg>",
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    ]
    for (const payload of payloads) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      const html = renderToStaticMarkup(
        createElement(FragmentWrap, null, renderSafeCustomHead(payload))
      )
      expect(html.toLowerCase()).not.toContain("<script")
      expect(html.toLowerCase()).not.toContain("onload=")
      expect(html.toLowerCase()).not.toContain("onerror=")
      expect(html.toLowerCase()).not.toContain("http-equiv")
      expect(html).not.toContain("alert(1)")
      // Warning must not echo the unsafe value.
      expect(warn).toHaveBeenCalled()
      for (const call of warn.mock.calls) {
        const line = String(call[0] ?? "")
        expect(line).not.toContain(payload)
        expect(line).not.toContain("alert(1)")
        const parsed = JSON.parse(line) as {
          event: string
          reason: string
        }
        expect(parsed.event).toBe("status_page.custom_head_rejected")
        expect(parsed.reason.length).toBeGreaterThan(0)
      }
      warn.mockRestore()
    }
  })

  it("returns null for null or empty input without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(renderSafeCustomHead(null)).toBeNull()
    expect(renderSafeCustomHead(undefined)).toBeNull()
    expect(renderSafeCustomHead("")).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("customHeadElementsToReact", () => {
  it("maps charset to charSet for React", () => {
    const html = renderToStaticMarkup(
      createElement(
        FragmentWrap,
        null,
        customHeadElementsToReact([
          { tag: "meta", attrs: { charset: "utf-8" } },
        ])
      )
    )
    // React SSR may emit charSet or charset depending on the renderer.
    expect(html.toLowerCase()).toMatch(/<meta\s+charset="utf-8"\s*\/>/)
  })
})

function FragmentWrap({ children }: { children: ReactNode }) {
  return createElement("div", null, children)
}
