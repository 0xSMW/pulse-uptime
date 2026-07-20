import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import degraded from "./fixtures/neon/degraded.json";
import maintenance from "./fixtures/neon/maintenance.json";
import malformed from "./fixtures/neon/malformed.json";
import missingComponent from "./fixtures/neon/missing-component.json";
import operational from "./fixtures/neon/operational.json";
import outage from "./fixtures/neon/outage.json";
import unknownStatus from "./fixtures/neon/unknown-status.json";
import type { AdapterDocument } from "./index";
import { AdapterParseError } from "./shared";
import { statusioPublicAdapter } from "./statusio-public";

const manifest = loadCatalogManifest();
const neonSource = manifest.sources.find((source) => source.id === "neon")!;
const neonPreset = manifest.presets.find((preset) => preset.id === "neon_database")!;

function currentDoc(json: unknown): AdapterDocument {
  return { kind: "current", url: neonSource.currentUrl, json };
}

describe("statusioPublicAdapter.requests", () => {
  it("requests only the current state document, Neon's incident endpoints return 403", () => {
    expect(statusioPublicAdapter.requests(neonSource)).toEqual([{ kind: "current", url: neonSource.currentUrl, optional: false }]);
  });
});

describe("statusioPublicAdapter.normalize: component and region selection against the catalog", () => {
  it("selects the neon_database preset's component and its required region containers", () => {
    expect(neonPreset.selector).toMatchObject({ kind: "statusio_component_container", componentId: "690ccc238c3745059f2b33b2" });
    expect(neonPreset.scope).toMatchObject({ kind: "required_options" });
    const snapshot = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(operational)], observedAt: "2026-07-19T12:00:00.000Z" });
    expect(snapshot.components["690ccc238c3745059f2b33b2"]).toMatchObject({ state: "OPERATIONAL" });
    const region = neonPreset.scope?.kind === "required_options" ? neonPreset.scope.options[0] : null;
    expect(region?.id).toBe("690ccafbbfd4c50578f181cc");
    expect(snapshot.components[region!.id]).toMatchObject({ state: "OPERATIONAL" });
  });

  it("maps a degraded region container independently from the parent component's own state", () => {
    const snapshot = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(degraded)], observedAt: "2026-07-19T13:00:00.000Z" });
    expect(snapshot.components["690ccc238c3745059f2b33b2"]).toMatchObject({ state: "DEGRADED" });
    expect(snapshot.components["690ccafbbfd4c50578f181cc"]).toMatchObject({ state: "OPERATIONAL" });
    expect(snapshot.components["690ccb48769e0d058c5c353d"]).toMatchObject({ state: "DEGRADED" });
  });

  it("maps Service Disruption to OUTAGE", () => {
    const snapshot = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(outage)], observedAt: "2026-07-19T14:00:00.000Z" });
    expect(snapshot.components["690ccc238c3745059f2b33b2"]).toMatchObject({ state: "OUTAGE" });
  });

  it("maps Planned Maintenance to MAINTENANCE", () => {
    const snapshot = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(maintenance)], observedAt: "2026-07-19T02:00:00.000Z" });
    expect(snapshot.components["690ccc238c3745059f2b33b2"]).toMatchObject({ state: "MAINTENANCE" });
  });
});

describe("statusioPublicAdapter.normalize: no invented incidents", () => {
  it("never populates incidents or maintenances, current state only", () => {
    const snapshot = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(outage)], observedAt: "2026-07-19T14:00:00.000Z" });
    expect(snapshot.incidents).toEqual([]);
    expect(snapshot.maintenances).toEqual([]);
  });

  it("normalizing the same fixture twice yields an identical snapshot shape", () => {
    const first = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(operational)], observedAt: "2026-07-19T12:00:00.000Z" });
    const second = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(operational)], observedAt: "2026-07-19T12:01:00.000Z" });
    expect(first.components).toEqual(second.components);
  });
});

describe("statusioPublicAdapter.normalize: failure handling", () => {
  it("throws AdapterParseError on an unrecognized top-level shape", () => {
    expect(() => statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(malformed)], observedAt: "2026-07-19T12:00:00.000Z" })).toThrow(AdapterParseError);
  });

  it("throws on an unknown Status.io status string instead of guessing", () => {
    try {
      statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(unknownStatus)], observedAt: "2026-07-19T12:00:00.000Z" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError);
      expect((error as AdapterParseError).code).toBe("UNKNOWN_STATUS");
    }
  });

  it("does not throw when the configured component id is no longer in the feed", () => {
    const snapshot = statusioPublicAdapter.normalize({ source: neonSource, documents: [currentDoc(missingComponent)], observedAt: "2026-07-19T12:00:00.000Z" });
    expect(snapshot.components["690ccc238c3745059f2b33b2"]).toBeUndefined();
    // componentsComplete true (FIX B): a successful status document
    // enumerates every component, so this absence resolves to UNKNOWN.
    expect(snapshot.componentsComplete).toBe(true);
  });
});
