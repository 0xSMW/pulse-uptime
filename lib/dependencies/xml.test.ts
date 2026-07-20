import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseFeed, XmlParseError } from "./xml";

const RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Provider Status</title>
    <item>
      <title>API degraded &amp; slow</title>
      <link>https://status.example.com/incidents/1</link>
      <guid>incident-1</guid>
      <pubDate>Mon, 20 Jul 2026 10:00:00 GMT</pubDate>
      <category>API</category>
      <category>Webhooks</category>
      <description><![CDATA[<p>We are <b>investigating</b> elevated errors.</p>]]></description>
    </item>
    <item>
      <title>Resolved</title>
      <link>https://status.example.com/incidents/2</link>
      <guid>incident-2</guid>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Provider</title>
  <entry>
    <title>Region outage</title>
    <id>urn:uuid:abc</id>
    <link href="https://status.example.com/e/abc" rel="alternate"/>
    <updated>2026-07-20T10:00:00Z</updated>
    <category term="compute"/>
    <summary>Compute is unavailable in one region.</summary>
  </entry>
</feed>`;

describe("parseFeed RSS and Atom", () => {
  it("extracts bounded plain-text items from RSS", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      guid: "incident-1",
      title: "API degraded & slow",
      link: "https://status.example.com/incidents/1",
      pubDate: "Mon, 20 Jul 2026 10:00:00 GMT",
      categories: ["API", "Webhooks"],
      description: "We are investigating elevated errors.",
    });
    expect(items[1].guid).toBe("incident-2");
    expect(items[1].description).toBeNull();
    expect(items[1].categories).toEqual([]);
  });

  it("reads Atom entries, taking the link href and category term", () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      guid: "urn:uuid:abc",
      title: "Region outage",
      link: "https://status.example.com/e/abc",
      pubDate: "2026-07-20T10:00:00Z",
      categories: ["compute"],
      description: "Compute is unavailable in one region.",
    });
  });

  it("strips markup and collapses whitespace inside text fields", () => {
    const feed = "<rss><channel><item><description>line one\n\n  line   two<script>x</script></description></item></channel></rss>";
    expect(parseFeed(feed)[0].description).toBe("line one line twox");
  });
});

describe("parseFeed hardening", () => {
  it("rejects a document that declares entities (billion-laughs / XXE vector)", () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<rss><channel><item><title>&lol3;</title></item></channel></rss>`;
    expect(() => parseFeed(bomb)).toThrow(XmlParseError);
    try {
      parseFeed(bomb);
    } catch (error) {
      expect((error as XmlParseError).code).toBe("DTD_FORBIDDEN");
    }
  });

  it("rejects an external DTD subset", () => {
    const external = `<!DOCTYPE rss SYSTEM "https://evil.example/x.dtd"><rss><channel></channel></rss>`;
    expect(() => parseFeed(external)).toThrow(XmlParseError);
  });

  it("never expands an undefined custom entity, leaving it inert", () => {
    // No ENTITY declaration, so this passes the DTD guard, but &xxe; is not a
    // predefined entity and must stay literal rather than resolve to anything.
    const feed = "<rss><channel><item><title>value &xxe; here</title></item></channel></rss>";
    expect(parseFeed(feed)[0].title).toBe("value &xxe; here");
  });

  it("rejects oversized input before scanning", () => {
    const huge = `<rss><channel><item><title>${"a".repeat(2000)}</title></item></channel></rss>`;
    expect(() => parseFeed(huge, { maxInputBytes: 1000 })).toThrow(XmlParseError);
    try {
      parseFeed(huge, { maxInputBytes: 1000 });
    } catch (error) {
      expect((error as XmlParseError).code).toBe("OVERSIZED");
    }
  });

  it("caps the number of items and the length of each text field", () => {
    const manyItems = Array.from({ length: 50 }, (_, index) => `<item><title>t${index}</title></item>`).join("");
    const items = parseFeed(`<rss><channel>${manyItems}</channel></rss>`, { maxItems: 5 });
    expect(items).toHaveLength(5);

    const long = `<rss><channel><item><title>${"z".repeat(500)}</title></item></channel></rss>`;
    expect(parseFeed(long, { maxTextLength: 16 })[0].title).toHaveLength(16);
  });

  it("decodes numeric character references but ignores out-of-range ones", () => {
    const feed = "<rss><channel><item><title>&#65;&#x42; &#0; &#1114113;</title></item></channel></rss>";
    // 65 -> A, 0x42 -> B, and the invalid code points stay literal.
    expect(parseFeed(feed)[0].title).toBe("AB &#0; &#1114113;");
  });
});
