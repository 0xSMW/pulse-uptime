import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import operational from "./fixtures/digitalocean/operational.json";
import type { AdapterDocument } from "./index";
import { statuspageV2Adapter } from "./statuspage-v2";

// DigitalOcean's status feed is Atlassian Statuspage v2, so it rides the shared
// statuspage_v2 adapter. This suite pins the catalog's DigitalOcean source and
// presets to real component ids captured from status.digitalocean.com, so a
// preset can never reference an id the live feed does not carry.

const manifest = loadCatalogManifest();
const source = manifest.sources.find((entry) => entry.id === "digitalocean")!;
const apiPreset = manifest.presets.find((preset) => preset.id === "digitalocean_api")!;
const dropletsPreset = manifest.presets.find((preset) => preset.id === "digitalocean_droplets")!;
const databasesPreset = manifest.presets.find((preset) => preset.id === "digitalocean_managed_databases")!;

function currentDoc(json: unknown): AdapterDocument {
  return { kind: "current", url: source.currentUrl, json };
}

describe("DigitalOcean catalog source", () => {
  it("uses the statuspage_v2 adapter against status.digitalocean.com", () => {
    expect(source.adapter).toBe("statuspage_v2");
    expect(source.currentUrl).toBe("https://status.digitalocean.com/api/v2/summary.json");
    expect(source.allowedHosts).toContain("status.digitalocean.com");
  });
});

describe("DigitalOcean preset component selection against the live feed", () => {
  const snapshot = statuspageV2Adapter.normalize({ source, documents: [currentDoc(operational)], observedAt: "2026-07-19T15:32:39Z" });

  it("resolves every selector id present in the sanitized live summary", () => {
    const selectorIds = [apiPreset, dropletsPreset, databasesPreset]
      .flatMap((preset) => (preset.selector.kind === "component_ids" ? preset.selector.ids : []));
    for (const id of selectorIds) {
      expect(snapshot.components[id]).toBeDefined();
    }
  });

  it("selects the API component and reports it operational", () => {
    expect(apiPreset.selector).toMatchObject({ kind: "component_ids", ids: ["p1x9rv4137gx"] });
    expect(snapshot.components["p1x9rv4137gx"]).toMatchObject({ state: "OPERATIONAL" });
  });

  it("scopes Droplets and Managed Databases to their regional group aggregates", () => {
    expect(dropletsPreset.scope).toMatchObject({ kind: "discovered_children", groupId: "4rgs7bbljl8d", required: true });
    expect(databasesPreset.scope).toMatchObject({ kind: "discovered_children", groupId: "kl8qv98c9brp", required: true });
    // The selector aggregate id is the parent group's own rollup component,
    // mirroring the Supabase and Upstash regional presets.
    if (dropletsPreset.selector.kind === "component_ids") expect(dropletsPreset.selector.ids).toEqual([dropletsPreset.scope?.kind === "discovered_children" ? dropletsPreset.scope.groupId : ""]);
    if (databasesPreset.selector.kind === "component_ids") expect(databasesPreset.selector.ids).toEqual([databasesPreset.scope?.kind === "discovered_children" ? databasesPreset.scope.groupId : ""]);
    expect(snapshot.components["4rgs7bbljl8d"]).toMatchObject({ state: "OPERATIONAL" });
    expect(snapshot.components["kl8qv98c9brp"]).toMatchObject({ state: "OPERATIONAL" });
  });

  it("carries the regional children the discovered_children scope resolves at validation time", () => {
    // A regional child of each group (Droplets FRA1, Managed Databases NYC1)
    // is present in the feed, confirming the groups genuinely fan out per region.
    expect(snapshot.components["kkg2cfkqkwj1"]).toBeDefined();
    expect(snapshot.components["d2m7jh32j7z1"]).toBeDefined();
  });

  it("builds a complete catalog directory with childrenByParent for Droplets and Managed Databases", () => {
    const directory = statuspageV2Adapter.catalogDirectory({
      source,
      documents: [currentDoc(operational)],
    });
    expect(directory.complete).toBe(true);
    expect(directory.componentIds.has("4rgs7bbljl8d")).toBe(true);
    expect(directory.componentIds.has("kl8qv98c9brp")).toBe(true);

    const dropletChildren = directory.childrenByParent.get("4rgs7bbljl8d") ?? [];
    const databaseChildren = directory.childrenByParent.get("kl8qv98c9brp") ?? [];
    expect(dropletChildren.map((child) => child.id)).toContain("kkg2cfkqkwj1");
    expect(dropletChildren.find((child) => child.id === "kkg2cfkqkwj1")?.label).toBe("FRA1");
    expect(databaseChildren.map((child) => child.id)).toContain("d2m7jh32j7z1");
    expect(dropletChildren.length).toBeGreaterThan(1);
    expect(databaseChildren.length).toBeGreaterThan(1);
  });

  it("maps a degraded group rollup onto DEGRADED", () => {
    const degraded = JSON.parse(JSON.stringify(operational));
    const droplets = degraded.components.find((component: { id: string }) => component.id === "4rgs7bbljl8d");
    droplets.status = "partial_outage";
    const snap = statuspageV2Adapter.normalize({ source, documents: [currentDoc(degraded)], observedAt: "2026-07-19T16:00:00Z" });
    expect(snap.components["4rgs7bbljl8d"]).toMatchObject({ state: "DEGRADED" });
  });
});
