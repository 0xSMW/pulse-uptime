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
  "DigitalOcean",
  "Auth0",
  "AWS",
  "Hetzner",
  "OpenRouter",
  "Azure",
];

const HELD_PROVIDER_NAMES: string[] = [];

describe("loadCatalogManifest", () => {
  it("parses the shipped catalog.json without throwing", () => {
    expect(() => loadCatalogManifest()).not.toThrow();
  });

  it("ships schemaVersion 1 and the expected catalog version", () => {
    const manifest = loadCatalogManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.catalogVersion).toBe("2026-07-20.3");
  });

  it("declares incidentInventory for every incident_feed source", () => {
    const manifest = loadCatalogManifest();
    const feeds = manifest.sources.filter((source) => source.adapter === "incident_feed");
    expect(feeds.length).toBeGreaterThanOrEqual(2);
    for (const source of feeds) {
      expect(["active_only", "rolling_history"]).toContain(source.config.incidentInventory);
    }
    expect(manifest.sources.find((source) => source.id === "azure")?.config.incidentInventory).toBe("active_only");
    expect(manifest.sources.find((source) => source.id === "openrouter")?.config.incidentInventory).toBe("rolling_history");
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

describe("catalogManifestSchema fidelity", () => {
  const base = () => loadCatalogManifest();

  it("accepts an incident_only fidelity on a source and a preset", () => {
    const manifest = base();
    const withFidelity = {
      ...manifest,
      sources: [{ ...manifest.sources[0], fidelity: "incident_only" }, ...manifest.sources.slice(1)],
      presets: [{ ...manifest.presets[0], fidelity: "incident_only" }, ...manifest.presets.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(withFidelity)).not.toThrow();
  });

  it("treats a missing fidelity as valid, defaulting resolution to component at sync time", () => {
    const manifest = base();
    expect(manifest.sources.every((source) => source.fidelity === undefined || source.fidelity === "component" || source.fidelity === "incident_only")).toBe(true);
    expect(() => catalogManifestSchema.parse(manifest)).not.toThrow();
  });

  it("rejects an unknown fidelity value", () => {
    const manifest = base();
    const broken = {
      ...manifest,
      presets: [{ ...manifest.presets[0], fidelity: "guessed" }, ...manifest.presets.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(broken)).toThrow();
  });
});

describe("catalogManifestSchema source config", () => {
  const base = () => loadCatalogManifest();

  it("accepts a per-source maxBodyBytes within the 4MB ceiling", () => {
    const manifest = base();
    const raised = {
      ...manifest,
      sources: [{ ...manifest.sources[0], config: { ...manifest.sources[0].config, maxBodyBytes: 2 * 1024 * 1024 } }, ...manifest.sources.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(raised)).not.toThrow();
  });

  it("rejects a maxBodyBytes above the 4MB ceiling", () => {
    const manifest = base();
    const overCeiling = {
      ...manifest,
      sources: [{ ...manifest.sources[0], config: { ...manifest.sources[0].config, maxBodyBytes: 8 * 1024 * 1024 } }, ...manifest.sources.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(overCeiling)).toThrow();
  });

  it("still passes through adapter-specific config keys alongside maxBodyBytes", () => {
    const manifest = base();
    const withExtra = {
      ...manifest,
      sources: [{ ...manifest.sources[0], config: { productsUrl: "https://status.example.com/products.json", maxBodyBytes: 1024 * 1024 } }, ...manifest.sources.slice(1)],
    };
    const parsed = catalogManifestSchema.parse(withExtra);
    expect(parsed.sources[0].config).toMatchObject({ productsUrl: "https://status.example.com/products.json", maxBodyBytes: 1024 * 1024 });
  });
});

describe("catalogManifestSchema adapter names", () => {
  const base = () => loadCatalogManifest();

  it("accepts the four provider-agent adapter names ahead of their modules", () => {
    const manifest = base();
    for (const adapter of ["aws_health", "nextdata_embedded", "incident_feed", "auth0_status"]) {
      const source = adapter === "incident_feed"
        ? { ...manifest.sources[0], adapter, config: { ...manifest.sources[0].config, incidentInventory: "active_only" } }
        : { ...manifest.sources[0], adapter };
      const withAdapter = {
        ...manifest,
        sources: [source, ...manifest.sources.slice(1)],
      };
      expect(() => catalogManifestSchema.parse(withAdapter)).not.toThrow();
    }
  });

  it("rejects an adapter name outside the union", () => {
    const manifest = base();
    const broken = {
      ...manifest,
      sources: [{ ...manifest.sources[0], adapter: "made_up_adapter" }, ...manifest.sources.slice(1)],
    };
    expect(() => catalogManifestSchema.parse(broken)).toThrow();
  });
});

describe("catalogManifestSchema incident_feed inventory", () => {
  const base = () => loadCatalogManifest();

  it("rejects an incident_feed source that omits incidentInventory", () => {
    const manifest = base();
    const azure = manifest.sources.find((source) => source.id === "azure")!;
    const { incidentInventory: _dropped, ...configWithout } = azure.config as { incidentInventory?: string } & Record<string, unknown>;
    void _dropped;
    const broken = {
      ...manifest,
      sources: manifest.sources.map((source) =>
        source.id === "azure" ? { ...source, config: configWithout } : source,
      ),
    };
    expect(() => catalogManifestSchema.parse(broken)).toThrow(/incidentInventory/);
  });

  it("rejects an unknown incidentInventory value", () => {
    const manifest = base();
    const broken = {
      ...manifest,
      sources: manifest.sources.map((source) =>
        source.id === "azure" ? { ...source, config: { ...source.config, incidentInventory: "guessed" } } : source,
      ),
    };
    expect(() => catalogManifestSchema.parse(broken)).toThrow(/incidentInventory/);
  });

  it("does not require incidentInventory on non-incident_feed adapters", () => {
    const manifest = base();
    const vercel = manifest.sources.find((source) => source.id === "vercel")!;
    expect(vercel.adapter).not.toBe("incident_feed");
    expect(vercel.config.incidentInventory).toBeUndefined();
    expect(() => catalogManifestSchema.parse(manifest)).not.toThrow();
  });
});
