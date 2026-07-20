import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import degraded from "./fixtures/google_cloud/degraded.json";
import malformed from "./fixtures/google_cloud/malformed.json";
import missingComponent from "./fixtures/google_cloud/missing-component.json";
import operational from "./fixtures/google_cloud/operational.json";
import outage from "./fixtures/google_cloud/outage.json";
import partialRecovery from "./fixtures/google_cloud/partial-recovery.json";
import resolved from "./fixtures/google_cloud/resolved.json";
import { googleCloudStatusAdapter } from "./google-cloud-status";
import type { AdapterDocument } from "./index";
import { AdapterParseError } from "./shared";

const manifest = loadCatalogManifest();
const googleSource = manifest.sources.find((source) => source.id === "google_cloud")!;
const geminiPreset = manifest.presets.find((preset) => preset.id === "google_vertex_gemini")!;
const cloudRunPreset = manifest.presets.find((preset) => preset.id === "google_cloud_run")!;

function currentDoc(json: unknown): AdapterDocument {
  return { kind: "current", url: googleSource.currentUrl, json };
}

describe("googleCloudStatusAdapter.requests", () => {
  it("requests the single incidents.json document that serves both current state and history", () => {
    expect(googleCloudStatusAdapter.requests(googleSource)).toEqual([{ kind: "current", url: googleSource.currentUrl, optional: false }]);
  });
});

describe("googleCloudStatusAdapter.normalize: status_impact mapping", () => {
  it("treats a product with no active matching incident as absent, callers read that as OPERATIONAL", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(operational)], observedAt: "2026-07-19T12:00:00Z" });
    expect(geminiPreset.selector.kind === "google_product" ? geminiPreset.selector.productId : null).toBe("Z0FZJAMvEB4j3NbCJs6B");
    expect(snapshot.components["Z0FZJAMvEB4j3NbCJs6B"]).toBeUndefined();
  });

  it("maps SERVICE_DISRUPTION to DEGRADED for the vertex gemini preset's product id", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(degraded)], observedAt: "2026-07-19T10:30:00Z" });
    expect(snapshot.components["Z0FZJAMvEB4j3NbCJs6B"]).toMatchObject({ state: "DEGRADED" });
  });

  it("maps SERVICE_OUTAGE to OUTAGE for the cloud run preset's product id", () => {
    expect(cloudRunPreset.selector).toMatchObject({ kind: "google_product", productId: "9D7d2iNBQWN24zc1VamE" });
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(outage)], observedAt: "2026-07-19T09:20:00Z" });
    expect(snapshot.components["9D7d2iNBQWN24zc1VamE"]).toMatchObject({ state: "OUTAGE" });
  });

  it("does not contribute a resolved incident to current component state", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(resolved)], observedAt: "2026-07-17T10:00:00Z" });
    expect(snapshot.components["Z0FZJAMvEB4j3NbCJs6B"]).toBeUndefined();
    expect(snapshot.incidents[0].state).toBe("resolved");
    expect(snapshot.incidents[0].resolvedAt).toBe("2026-07-17T09:30:00+00:00");
  });
});

describe("googleCloudStatusAdapter.normalize: location selection", () => {
  it("carries a productId@locationId composite alongside the bare product id for optional location scoping", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(degraded)], observedAt: "2026-07-19T10:30:00Z" });
    const [incident] = snapshot.incidents;
    expect(incident.componentIds).toContain("Z0FZJAMvEB4j3NbCJs6B");
    expect(incident.componentIds).toContain("Z0FZJAMvEB4j3NbCJs6B@us-east4");
  });

  it("excludes a recovered location from an active incident's composites so its scope is no longer touched", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(partialRecovery)], observedAt: "2026-07-19T11:05:00Z" });
    const [incident] = snapshot.incidents;
    expect(incident.resolvedAt).toBeNull();
    expect(incident.componentIds).toContain("Z0FZJAMvEB4j3NbCJs6B");
    expect(incident.componentIds).toContain("Z0FZJAMvEB4j3NbCJs6B@us-central1");
    expect(incident.componentIds).not.toContain("Z0FZJAMvEB4j3NbCJs6B@us-east4");
  });

  it("keeps a resolved incident's previously affected location composite for historical matching", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(resolved)], observedAt: "2026-07-17T10:00:00Z" });
    const [incident] = snapshot.incidents;
    expect(incident.resolvedAt).not.toBeNull();
    expect(incident.componentIds).toContain("Z0FZJAMvEB4j3NbCJs6B@us-east4");
  });
});

describe("googleCloudStatusAdapter.normalize: incident and update idempotency", () => {
  it("normalizing the same fixture twice yields identical incident and update external ids", () => {
    const first = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(outage)], observedAt: "2026-07-19T09:20:00Z" });
    const second = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(outage)], observedAt: "2026-07-19T09:25:00Z" });
    expect(first.incidents.map((incident) => incident.externalId)).toEqual(second.incidents.map((incident) => incident.externalId));
    expect(first.incidents[0].updates.map((update) => update.externalId)).toEqual(second.incidents[0].updates.map((update) => update.externalId));
  });

  it("maps a final AVAILABLE update to resolved and earlier updates to identified", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(resolved)], observedAt: "2026-07-17T10:00:00Z" });
    expect(snapshot.incidents[0].updates.map((update) => update.state)).toEqual(["resolved", "identified"]);
  });
});

describe("googleCloudStatusAdapter.normalize: failure handling", () => {
  it("throws AdapterParseError when the document is not the documented top-level array", () => {
    expect(() => googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(malformed)], observedAt: "2026-07-19T12:00:00Z" })).toThrow(AdapterParseError);
  });

  it("does not throw when no incident currently affects the tracked product, it is simply absent", () => {
    const snapshot = googleCloudStatusAdapter.normalize({ source: googleSource, documents: [currentDoc(missingComponent)], observedAt: "2026-07-19T07:30:00Z" });
    expect(snapshot.components["Z0FZJAMvEB4j3NbCJs6B"]).toBeUndefined();
    expect(snapshot.components["9D7d2iNBQWN24zc1VamE"]).toBeUndefined();
    // componentsComplete false (FIX B): this feed only ever lists products
    // with an active incident, so an absent product legitimately means
    // operational, the one adapter exempted from the UNKNOWN rule.
    expect(snapshot.componentsComplete).toBe(false);
  });
});
