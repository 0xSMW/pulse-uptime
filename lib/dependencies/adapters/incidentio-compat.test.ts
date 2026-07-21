import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import degraded from "./fixtures/openai/degraded.json";
import incidentsResolved from "./fixtures/openai/incidents-resolved.json";
import maintenance from "./fixtures/openai/maintenance.json";
import malformed from "./fixtures/openai/malformed.json";
import missingComponent from "./fixtures/openai/missing-component.json";
import multiIncidentNoInference from "./fixtures/openai/multi-incident-no-inference.json";
import operational from "./fixtures/openai/operational.json";
import outage from "./fixtures/openai/outage.json";
import singleIncidentInferred from "./fixtures/openai/single-incident-inferred.json";
import { incidentioCompatAdapter } from "./incidentio-compat";
import type { AdapterDocument } from "./index";
import { AdapterParseError } from "./shared";

const manifest = loadCatalogManifest();
const openaiSource = manifest.sources.find((source) => source.id === "openai")!;
const chatgptPreset = manifest.presets.find((preset) => preset.id === "chatgpt")!;

function currentDoc(json: unknown): AdapterDocument {
  return { kind: "current", url: openaiSource.currentUrl, json };
}

describe("incidentioCompatAdapter.requests", () => {
  it("requests current and incidents, and never a Statuspage-only maintenance route", () => {
    const requests = incidentioCompatAdapter.requests(openaiSource);
    expect(requests).toEqual([
      { kind: "current", url: openaiSource.currentUrl, optional: false },
      { kind: "incidents", url: openaiSource.incidentsUrl, optional: false },
    ]);
    expect(requests.some((request) => request.kind === "maintenance")).toBe(false);
  });
});

describe("incidentioCompatAdapter.normalize: component status mapping", () => {
  it("maps operational, degraded_performance, major_outage, and under_maintenance", () => {
    const targetId = "01JP8CD9JR3HR6Y7G4Q75N4DVW";
    expect(incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(operational)], observedAt: "2026-07-19T12:00:00Z" }).components[targetId].state).toBe("OPERATIONAL");
    expect(incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(degraded)], observedAt: "2026-07-19T12:30:00Z" }).components[targetId].state).toBe("DEGRADED");
    expect(incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(outage)], observedAt: "2026-07-19T13:00:00Z" }).components[targetId].state).toBe("OUTAGE");
    const maintenanceTargetId = "01JMXBRMFEMZK0HPK19RYET250";
    expect(incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(maintenance)], observedAt: "2026-07-19T03:00:00Z" }).components[maintenanceTargetId].state).toBe("MAINTENANCE");
  });
});

describe("incidentioCompatAdapter.normalize: component selection against the catalog", () => {
  it("selects the chatgpt preset's Conversations component by its real upstream id", () => {
    expect(chatgptPreset.selector).toMatchObject({ kind: "component_ids" });
    const ids = chatgptPreset.selector.kind === "component_ids" ? chatgptPreset.selector.ids : [];
    expect(ids).toContain("01JMXBNJXGV1T5GT2M9XA83XNG");
    const snapshot = incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(singleIncidentInferred)], observedAt: "2026-07-19T15:05:00Z" });
    expect(snapshot.components["01JMXBNJXGV1T5GT2M9XA83XNG"].state).toBe("DEGRADED");
  });
});

describe("incidentioCompatAdapter.normalize: single active incident inference", () => {
  it("associates the sole active incident with every non-operational component in the same snapshot", () => {
    const snapshot = incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(singleIncidentInferred)], observedAt: "2026-07-19T15:05:00Z" });
    expect(snapshot.incidents).toHaveLength(1);
    const [incident] = snapshot.incidents;
    expect(incident.scope.kind).toBe("components");
    if (incident.scope.kind !== "components") throw new Error("expected components scope");
    expect([...incident.scope.componentIds].sort()).toEqual(["01K6TVGGGDCP0PPGCHXAG3AQX8", "01JMXBNJXGV1T5GT2M9XA83XNG", "01KX45G1SH21AX5DT93D4HMF0P"].sort());
  });

  it("normalizing the same fixture twice yields identical inferred component scope and update ids", () => {
    const first = incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(singleIncidentInferred)], observedAt: "2026-07-19T15:05:00Z" });
    const second = incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(singleIncidentInferred)], observedAt: "2026-07-19T15:06:00Z" });
    expect(first.incidents[0].scope).toEqual(second.incidents[0].scope);
    expect(first.incidents[0].updates.map((update) => update.externalId)).toEqual(second.incidents[0].updates.map((update) => update.externalId));
  });

  it("marks every incident unmapped, with no component guess, when several incidents are active at once", () => {
    const snapshot = incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(multiIncidentNoInference)], observedAt: "2026-07-19T16:05:00Z" });
    expect(snapshot.incidents).toHaveLength(2);
    for (const incident of snapshot.incidents) {
      expect(incident.scope).toEqual({ kind: "unmapped" });
    }
  });
});

describe("incidentioCompatAdapter.normalize: incident history", () => {
  it("maps a resolved incident's state through the incidents.json fallback shape", () => {
    const snapshot = incidentioCompatAdapter.normalize({
      source: openaiSource,
      documents: [{ kind: "incidents", url: openaiSource.incidentsUrl!, json: incidentsResolved }, currentDoc(operational)],
      observedAt: "2026-07-18T13:00:00Z",
    });
    const incident = snapshot.incidents.find((entry) => entry.externalId === "01KXT44TAQQ2R0AZDDVSJGAC4H");
    expect(incident?.state).toBe("resolved");
    expect(incident?.scope).toEqual({ kind: "unmapped" });
  });
});

describe("incidentioCompatAdapter.normalize: failure handling", () => {
  it("throws AdapterParseError on an unrecognized top-level shape", () => {
    expect(() => incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(malformed)], observedAt: "2026-07-19T12:00:00Z" })).toThrow(AdapterParseError);
  });

  it("does not throw when the feed drifts and a catalog component id disappears", () => {
    const snapshot = incidentioCompatAdapter.normalize({ source: openaiSource, documents: [currentDoc(missingComponent)], observedAt: "2026-07-19T12:00:00Z" });
    expect(snapshot.components["01JMXBRMFE6N2NNT7DG6XZQ6PW"]).toBeUndefined();
    // componentsComplete true (FIX B): a successful summary.json enumerates
    // every component, so this absence resolves the dependency to UNKNOWN.
    expect(snapshot.componentsComplete).toBe(true);
  });
});
