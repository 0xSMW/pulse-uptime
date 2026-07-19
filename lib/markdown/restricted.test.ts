import { describe, expect, it, vi } from "vitest";
import { renderRestrictedMarkdown } from "./restricted";

vi.mock("server-only", () => ({}));

const NUL = String.fromCharCode(0);

describe("restricted markdown rendering", () => {
  it("renders blank-line separated paragraphs", () => {
    expect(renderRestrictedMarkdown("First paragraph.\n\nSecond paragraph.")).toBe(
      "<p>First paragraph.</p>\n<p>Second paragraph.</p>",
    );
  });

  it("renders bold, italic, and inline code", () => {
    expect(renderRestrictedMarkdown("**bold** and *italic* and `code`")).toBe(
      "<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>",
    );
  });

  it("renders http, https, and mailto links with hardened rel/target", () => {
    expect(renderRestrictedMarkdown("[Pulse status](https://pulse.example.com)")).toBe(
      '<p><a href="https://pulse.example.com" target="_blank" rel="noopener noreferrer">Pulse status</a></p>',
    );
    expect(renderRestrictedMarkdown("[Email us](mailto:ops@example.com)")).toContain(
      'href="mailto:ops@example.com"',
    );
    expect(renderRestrictedMarkdown("[Plain](http://example.com)")).toContain(
      'href="http://example.com"',
    );
  });

  it("renders single newlines within a paragraph as <br>", () => {
    expect(renderRestrictedMarkdown("line one\nline two")).toBe("<p>line one<br>\nline two</p>");
  });

  it("collapses blank-line runs and whitespace-only lines between paragraphs", () => {
    expect(renderRestrictedMarkdown("a\n\n\n \t \n\nb")).toBe("<p>a</p>\n<p>b</p>");
  });

  it("trims paragraph edges and drops empty input", () => {
    expect(renderRestrictedMarkdown("  hello  ")).toBe("<p>hello</p>");
    expect(renderRestrictedMarkdown("")).toBe("");
    expect(renderRestrictedMarkdown(" \n \n ")).toBe("");
  });

  it("normalizes CRLF and lone CR line endings", () => {
    expect(renderRestrictedMarkdown("a\r\n\r\nb")).toBe("<p>a</p>\n<p>b</p>");
    expect(renderRestrictedMarkdown("a\r\nb")).toBe("<p>a<br>\nb</p>");
    expect(renderRestrictedMarkdown("a\rb")).toBe("<p>a<br>\nb</p>");
  });

  it("escapes script tags instead of rendering them", () => {
    const html = renderRestrictedMarkdown('<script>alert("xss")</script>');
    expect(html).toBe("<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>");
    expect(html).not.toContain("<script");
  });

  it("escapes all raw HTML rather than passing it through", () => {
    expect(renderRestrictedMarkdown("<b onclick='x'>hi</b>")).toBe(
      "<p>&lt;b onclick=&#39;x&#39;&gt;hi&lt;/b&gt;</p>",
    );
  });

  it("escapes quotes and ampersands exactly once", () => {
    expect(renderRestrictedMarkdown("He said \"hi\" & 'bye'")).toBe(
      "<p>He said &quot;hi&quot; &amp; &#39;bye&#39;</p>",
    );
  });

  it("does not double-decode pre-encoded entities", () => {
    expect(renderRestrictedMarkdown("Fish &amp; chips")).toBe("<p>Fish &amp;amp; chips</p>");
    expect(renderRestrictedMarkdown("&lt;script&gt;")).toBe("<p>&amp;lt;script&amp;gt;</p>");
  });

  it("rejects javascript: URLs in any casing", () => {
    for (const payload of [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](JAVASCRIPT:alert(1))",
    ]) {
      const html = renderRestrictedMarkdown(payload);
      expect(html).not.toContain("<a");
      expect(html).not.toContain("href");
    }
  });

  it("rejects data: and vbscript: URLs", () => {
    expect(
      renderRestrictedMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)"),
    ).not.toContain("<a");
    expect(renderRestrictedMarkdown("[x](vbscript:msgbox)")).not.toContain("<a");
  });

  it("rejects schemes smuggled with embedded whitespace or control characters", () => {
    expect(renderRestrictedMarkdown("[x](java\nscript:alert(1))")).not.toContain("href");
    expect(renderRestrictedMarkdown("[x](java\tscript:alert(1))")).not.toContain("href");
    expect(renderRestrictedMarkdown("[x](\tjavascript:alert(1))")).not.toContain("href");
  });

  it("rejects entity-obfuscated schemes because escaping happens first", () => {
    expect(renderRestrictedMarkdown("[x](javascript&colon;alert(1))")).not.toContain("href");
  });

  it("rejects relative and protocol-relative URLs", () => {
    expect(renderRestrictedMarkdown("[x](/status)")).not.toContain("<a");
    expect(renderRestrictedMarkdown("[x](//evil.example.com)")).not.toContain("<a");
  });

  it("allows an otherwise-valid URL with leading whitespace, compacted", () => {
    expect(renderRestrictedMarkdown("[x](  https://example.com)")).toContain(
      'href="https://example.com"',
    );
  });

  it("keeps quotes in URLs entity-escaped so attributes cannot be broken out of", () => {
    const html = renderRestrictedMarkdown('[x](https://example.com/"onmouseover="alert(1))');
    expect(html).toContain('href="https://example.com/&quot;onmouseover=&quot;alert(1"');
    expect(html).not.toContain('"onmouseover');
  });

  it("escapes attempted markup inside link text", () => {
    const html = renderRestrictedMarkdown("[<img src=x onerror=alert(1)>](https://example.com)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("renders links inside bold", () => {
    expect(renderRestrictedMarkdown("**[Docs](https://docs.example.com)**")).toBe(
      '<p><strong><a href="https://docs.example.com" target="_blank" rel="noopener noreferrer">Docs</a></strong></p>',
    );
  });

  it("renders emphasis and code spans inside link labels", () => {
    expect(renderRestrictedMarkdown("[**Docs**](https://example.com)")).toContain(
      "><strong>Docs</strong></a>",
    );
    expect(renderRestrictedMarkdown("[`code`](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer"><code>code</code></a></p>',
    );
  });

  it("leaves empty-label and unterminated links as plain text", () => {
    expect(renderRestrictedMarkdown("[](https://example.com)")).toBe(
      "<p>[](https://example.com)</p>",
    );
    expect(renderRestrictedMarkdown("[dangling](https://example.com")).toBe(
      "<p>[dangling](https://example.com</p>",
    );
  });

  it("does not render image syntax", () => {
    const html = renderRestrictedMarkdown("![alt](https://example.com/a.png)");
    expect(html).toBe("<p>![alt](https://example.com/a.png)</p>");
    expect(html).not.toContain("<img");
  });

  it("does not autolink bare or angle-bracketed URLs", () => {
    expect(renderRestrictedMarkdown("Visit https://example.com now")).toBe(
      "<p>Visit https://example.com now</p>",
    );
    expect(renderRestrictedMarkdown("<https://example.com>")).toBe(
      "<p>&lt;https://example.com&gt;</p>",
    );
  });

  it("treats markdown inside code spans as literal text", () => {
    const html = renderRestrictedMarkdown("`**not bold** [x](https://example.com)`");
    expect(html).toBe("<p><code>**not bold** [x](https://example.com)</code></p>");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<a");
  });

  it("escapes HTML inside code spans", () => {
    expect(renderRestrictedMarkdown("`<b>&</b>`")).toBe(
      "<p><code>&lt;b&gt;&amp;&lt;/b&gt;</code></p>",
    );
  });

  it("leaves unterminated and empty backticks literal", () => {
    expect(renderRestrictedMarkdown("`oops")).toBe("<p>`oops</p>");
    expect(renderRestrictedMarkdown("a `` b")).toBe("<p>a `` b</p>");
  });

  it("handles nested and unbalanced emphasis markers", () => {
    expect(renderRestrictedMarkdown("***both***")).toBe(
      "<p><em><strong>both</strong></em></p>",
    );
    expect(renderRestrictedMarkdown("**dangling")).toBe("<p>**dangling</p>");
    expect(renderRestrictedMarkdown("*dangling")).toBe("<p>*dangling</p>");
    const unbalanced = renderRestrictedMarkdown("**text*");
    expect(unbalanced).toBe("<p>*<em>text</em></p>");
    expect(unbalanced).not.toContain("<strong>");
  });

  it("does not render headings or lists", () => {
    expect(renderRestrictedMarkdown("# Not a heading")).toBe("<p># Not a heading</p>");
    expect(renderRestrictedMarkdown("- not a list item")).toBe("<p>- not a list item</p>");
  });

  it("truncates input beyond 16 KB before processing", () => {
    expect(renderRestrictedMarkdown("x".repeat(17_000))).toBe(`<p>${"x".repeat(16_384)}</p>`);
  });

  it("never processes payloads hidden past the truncation boundary", () => {
    const html = renderRestrictedMarkdown("a".repeat(16_384) + "<script>alert(1)</script>");
    expect(html).toBe(`<p>${"a".repeat(16_384)}</p>`);
  });

  it("strips NUL bytes so placeholder tokens cannot be forged", () => {
    expect(renderRestrictedMarkdown(`a${NUL}b`)).toBe("<p>ab</p>");
    expect(renderRestrictedMarkdown(`\`x\` ${NUL}0${NUL}`)).toBe("<p><code>x</code> 0</p>");
  });
});
