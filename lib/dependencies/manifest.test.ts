import { describe, expect, it } from "vitest";

import { catalogManifestSchema, loadCatalogManifest } from "./manifest";

const LAUNCH_PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "Google Cloud",
  "Vercel",
  "Cloudflare",
  "WorkOS",
  "Clerk",
  "Neon",
  "Supabase",
  "Upstash",
  "Stripe",
  "Resend",
  "Postmark",
  "Twilio",
  "GitHub",
];

const HELD_PROVIDER_NAMES = ["openrouter", "auth0", "aws"];

describe("loadCatalogManifest", () => {
  it("parses the shipped catalog.json without throwing", () => {
    expect(() => loadCatalogManifest()).not.toThrow();
  });

  it("ships schemaVersion 1 and the expected catalog version", () => {
    const manifest = loadCatalogManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.catalogVersion).toBe("2026-07-19.2");
  });

  it("includes every launch-ready provider from the registry", () => {
    const manifest = loadCatalogManifest();
    const providers = manifest.sources.map((source) => source.provider);
    for (const provider of LAUNCH_PROVIDERS) {
      expect(providers).toContain(provider);
    }
    expect(providers).toHaveLength(LAUNCH_PROVIDERS.length);
  });

  it("never ships a source or preset for a held provider", () => {
    const manifest = loadCatalogManifest();
    const haystack = [
      ...manifest.sources.map((source) => `${source.id} ${source.provider}`),
      ...manifest.presets.map((preset) => `${preset.id} ${preset.name}`),
    ].join(" ").toLowerCase();
    for (const held of HELD_PROVIDER_NAMES) {
      expect(haystack).not.toContain(held);
    }
  });

  it("gives every preset a source that exists in the manifest", () => {
    const manifest = loadCatalogManifest();
    const sourceIds = new Set(manifest.sources.map((source) => source.id));
    for (const preset of manifest.presets) {
      expect(sourceIds.has(preset.sourceId)).toBe(true);
    }
  });

  it("keeps source and preset IDs unique", () => {
    const manifest = loadCatalogManifest();
    expect(new Set(manifest.sources.map((source) => source.id)).size).toBe(manifest.sources.length);
    expect(new Set(manifest.presets.map((preset) => preset.id)).size).toBe(manifest.presets.length);
  });

  it("only ever declares allowed hosts that match its own URLs", () => {
    const manifest = loadCatalogManifest();
    for (const source of manifest.sources) {
      const hosts = [source.currentUrl, source.statusPageUrl, ...(source.incidentsUrl ? [source.incidentsUrl] : [])]
        .map((url) => new URL(url).hostname);
      for (const host of hosts) {
        expect(source.allowedHosts).toContain(host);
      }
    }
  });

  it("requires a region for Neon and only ever offers validated region containers", () => {
    const manifest = loadCatalogManifest();
    const neon = manifest.presets.find((preset) => preset.id === "neon_database");
    expect(neon?.scope).toMatchObject({ kind: "required_options" });
    if (neon?.scope?.kind === "required_options") {
      expect(neon.scope.options).toHaveLength(11);
    }
  });

  it("discloses the wider scope of Stripe's broad presets", () => {
    const manifest = loadCatalogManifest();
    const checkout = manifest.presets.find((preset) => preset.id === "stripe_checkout");
    const webhooks = manifest.presets.find((preset) => preset.id === "stripe_webhooks");
    expect(checkout?.sourceScopeNote).toBe("Provider source also covers Elements, Connect, Payment Links, Terminal, and 3DS.");
    expect(webhooks?.sourceScopeNote).toBe("Provider source also covers Dashboard, support, and payouts.");
  });
});

describe("catalogManifestSchema invariants", () => {
  const base = () => loadCatalogManifest();

  it("rejects unknown top-level keys", () => {
    const manifest = { ...base(), extra: true };
    expect(() => catalogManifestSchema.parse(manifest)).toThrow();
  });

  it("rejects a preset referencing a source that does not exist", () => {
    const manifest = base();
    const broken = {
      ...manifest,
      presets: [{ ...manifest.presets[0], sourceId: "does-not-exist" }, ...manifest.presets.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(broken)).toThrow();
  });

  it("rejects duplicate source IDs", () => {
    const manifest = base();
    const broken = { ...manifest, sources: [manifest.sources[0], manifest.sources[0]] };
    expect(() => catalogManifestSchema.parse(broken)).toThrow();
  });

  it("rejects a source whose allowedHosts do not cover its URLs", () => {
    const manifest = base();
    const broken = {
      ...manifest,
      sources: [{ ...manifest.sources[0], allowedHosts: ["not-the-right-host.example"] }, ...manifest.sources.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(broken)).toThrow();
  });
});
