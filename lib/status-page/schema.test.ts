import { describe, expect, it } from "vitest";

import {
  parseStatusPageConfigDocument,
  statusPageConfigDocumentSchema,
  type StatusPageConfigDocument,
} from "./schema";

const IMAGE_ID = "11111111-1111-4111-8111-111111111111";

function baseDocument(overrides: Partial<StatusPageConfigDocument> = {}): Record<string, unknown> {
  return {
    name: "System Status",
    layout: "vertical",
    theme: "system",
    logoLightImageId: null,
    logoDarkImageId: null,
    faviconImageId: null,
    homepageUrl: null,
    contactUrl: null,
    navLinks: [],
    googleTagId: null,
    customCss: null,
    customHead: null,
    announcementEnabled: false,
    announcementMarkdown: null,
    historyDays: 90,
    uptimeDecimals: 2,
    unknownAsOperational: false,
    minIncidentSeconds: 0,
    timezone: null,
    ...overrides,
  };
}

function expectRejected(overrides: Record<string, unknown>) {
  expect(statusPageConfigDocumentSchema.safeParse({ ...baseDocument(), ...overrides }).success).toBe(false);
}

describe("status page config document schema", () => {
  it("accepts a fully populated document", () => {
    const result = statusPageConfigDocumentSchema.safeParse(baseDocument({
      name: "Acme Status",
      layout: "horizontal",
      theme: "dark",
      logoLightImageId: IMAGE_ID,
      homepageUrl: "https://acme.example",
      contactUrl: "mailto:ops@acme.example",
      navLinks: [{ label: "Docs", url: "https://acme.example/docs" }],
      googleTagId: "G-ABC123",
      customCss: "body { color: red }",
      customHead: "<meta name=\"robots\" content=\"noindex\">",
      announcementEnabled: true,
      announcementMarkdown: "**Maintenance** tonight",
      historyDays: 30,
      uptimeDecimals: 3,
      minIncidentSeconds: 120,
      timezone: "Asia/Bangkok",
    }));
    expect(result.success).toBe(true);
  });

  it("bounds the name to 1-80 characters", () => {
    expectRejected({ name: "" });
    expectRejected({ name: "   " });
    expectRejected({ name: "a".repeat(81) });
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ name: "a".repeat(80) })).success).toBe(true);
  });

  it("restricts layout, theme, historyDays, and uptimeDecimals to their enums", () => {
    expectRejected({ layout: "diagonal" });
    expectRejected({ theme: "midnight" });
    expectRejected({ historyDays: 45 });
    expectRejected({ uptimeDecimals: 4 });
    expectRejected({ uptimeDecimals: -1 });
    expectRejected({ uptimeDecimals: 1.5 });
  });

  it("requires image references to be UUIDs or null", () => {
    expectRejected({ logoLightImageId: "not-a-uuid" });
    expectRejected({ faviconImageId: 12 });
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ faviconImageId: IMAGE_ID })).success).toBe(true);
  });

  it("limits navLinks to 8 entries with bounded labels and http(s)/mailto URLs", () => {
    const link = { label: "Docs", url: "https://example.com" };
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ navLinks: Array(8).fill(link) })).success).toBe(true);
    expectRejected({ navLinks: Array(9).fill(link) });
    expectRejected({ navLinks: [{ label: "", url: "https://example.com" }] });
    expectRejected({ navLinks: [{ label: "a".repeat(41), url: "https://example.com" }] });
    expectRejected({ navLinks: [{ label: "Bad", url: "javascript:alert(1)" }] });
    expectRejected({ navLinks: [{ label: "Bad", url: "not a url" }] });
    expect(statusPageConfigDocumentSchema.safeParse(
      baseDocument({ navLinks: [{ label: "Mail", url: "mailto:ops@example.com" }] }),
    ).success).toBe(true);
  });

  it("restricts homepage to http(s) and contact to http(s)/mailto", () => {
    expectRejected({ homepageUrl: "mailto:ops@example.com" });
    expectRejected({ homepageUrl: "ftp://example.com" });
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ homepageUrl: "http://example.com" })).success).toBe(true);
    expectRejected({ contactUrl: "ftp://example.com" });
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ contactUrl: "mailto:ops@example.com" })).success).toBe(true);
  });

  it("validates the Google tag id format", () => {
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ googleTagId: "G-XYZ789" })).success).toBe(true);
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ googleTagId: "GT-XYZ789" })).success).toBe(true);
    expectRejected({ googleTagId: "UA-12345-1" });
    expectRejected({ googleTagId: "g-lower" });
  });

  it("caps custom css/head at 10 KB and the announcement at 2 KB of UTF-8", () => {
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ customCss: "x".repeat(10 * 1024) })).success).toBe(true);
    expectRejected({ customCss: "x".repeat(10 * 1024 + 1) });
    expectRejected({ customHead: "x".repeat(10 * 1024 + 1) });
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ announcementMarkdown: "x".repeat(2048) })).success).toBe(true);
    expectRejected({ announcementMarkdown: "x".repeat(2049) });
    // Multi-byte characters count as bytes, not characters.
    expectRejected({ announcementMarkdown: "€".repeat(700) });
  });

  it("bounds minIncidentSeconds to zero through seven days", () => {
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ minIncidentSeconds: 604800 })).success).toBe(true);
    expectRejected({ minIncidentSeconds: 604801 });
    expectRejected({ minIncidentSeconds: -1 });
  });

  it("requires timezone to be a real IANA zone or null", () => {
    expect(statusPageConfigDocumentSchema.safeParse(baseDocument({ timezone: "Asia/Bangkok" })).success).toBe(true);
    expectRejected({ timezone: "Not/AZone" });
    expectRejected({ timezone: "" });
  });

  it("rejects unknown fields and missing fields", () => {
    expectRejected({ sneaky: true });
    const { name: _name, ...missing } = baseDocument();
    void _name;
    expect(statusPageConfigDocumentSchema.safeParse(missing).success).toBe(false);
  });
});

describe("parseStatusPageConfigDocument", () => {
  it("strips read-side updatedAt and export _etag fields before validating", () => {
    const result = parseStatusPageConfigDocument({
      ...baseDocument(),
      updatedAt: "2026-07-18T00:00:00.000Z",
      _etag: '"1789000000000"',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("updatedAt" in result.data).toBe(false);
    }
  });

  it("strips the read-only version counter so a GET→PUT round-trip validates (finding: version was added to the read shape alongside the monotonic-ETag change but never stripped, so re-submitting a GET response failed the strict schema)", () => {
    const result = parseStatusPageConfigDocument({
      ...baseDocument(),
      updatedAt: "2026-07-18T00:00:00.000Z",
      version: 6,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("version" in result.data).toBe(false);
    }
  });

  it("rejects non-object documents", () => {
    expect(parseStatusPageConfigDocument(null).success).toBe(false);
    expect(parseStatusPageConfigDocument([]).success).toBe(false);
    expect(parseStatusPageConfigDocument("{}").success).toBe(false);
  });
});
