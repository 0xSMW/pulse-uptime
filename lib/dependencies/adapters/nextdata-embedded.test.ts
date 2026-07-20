import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import type { AdapterDocument } from "./index";
import { MAX_NEXT_DATA_BYTES, extractNextDataSlice, nextdataEmbeddedAdapter } from "./nextdata-embedded";
import { AdapterParseError } from "./shared";

// Hetzner serves no JSON status API. Its state lives in a Next.js __NEXT_DATA__
// script tag on the server-rendered status page. These fixtures are trimmed
// captures of that page: a minimal HTML wrapper plus a __NEXT_DATA__ payload
// whose systems ids are the exact integers the catalog pins.

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hetzner");
const readFixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf8");

const manifest = loadCatalogManifest();
const source = manifest.sources.find((entry) => entry.id === "hetzner")!;
const observedAt = "2026-07-20T12:00:00.000Z";

function currentDoc(html: string): AdapterDocument {
  return { kind: "current", url: source.currentUrl, text: html };
}

function normalize(html: string) {
  return nextdataEmbeddedAdapter.normalize({ source, documents: [currentDoc(html)], observedAt });
}

describe("Hetzner catalog source", () => {
  it("uses the nextdata_embedded adapter against status.hetzner.com", () => {
    expect(source.adapter).toBe("nextdata_embedded");
    expect(source.currentUrl).toBe("https://status.hetzner.com/");
    expect(source.statusPageUrl).toBe("https://status.hetzner.com/");
    expect(source.incidentsUrl).toBeNull();
    expect(source.allowedHosts).toEqual(["status.hetzner.com"]);
  });

  it("raises the body cap so the SSR HTML page has headroom, within the 4MB ceiling", () => {
    expect(source.config.maxBodyBytes).toBe(1024 * 1024);
  });
});

describe("Hetzner catalog presets", () => {
  const preset = (id: string) => manifest.presets.find((entry) => entry.id === id)!;

  it("pins each preset to the integer system id validated on the live page", () => {
    const cases: Array<[string, string, string[]]> = [
      ["hetzner_cloud_server", "Hetzner Cloud Server", ["3"]],
      ["hetzner_object_storage", "Hetzner Object Storage", ["91"]],
      ["hetzner_dedicated_server", "Hetzner Dedicated Server", ["6"]],
      ["hetzner_dns", "Hetzner DNS", ["78"]],
    ];
    for (const [id, name, ids] of cases) {
      const found = preset(id);
      expect(found.sourceId).toBe("hetzner");
      expect(found.name).toBe(name);
      expect(found.category).toBe("hosting");
      expect(found.enabled).toBe(true);
      expect(found.scope).toBeNull();
      expect(found.selector).toMatchObject({ kind: "component_ids", aggregation: "worst_of", ids });
    }
  });
});

describe("nextdataEmbeddedAdapter.requests", () => {
  it("asks for the status page once in text mode", () => {
    const requests = nextdataEmbeddedAdapter.requests(source);
    expect(requests).toEqual([{ kind: "current", url: source.currentUrl, optional: false, mode: "text" }]);
  });
});

describe("nextdataEmbeddedAdapter.normalize operational", () => {
  const snapshot = normalize(readFixture("operational.html"));

  it("enumerates every published system as a complete component set", () => {
    expect(snapshot.componentsComplete).toBe(true);
    for (const id of ["3", "91", "6", "36", "78"]) {
      expect(snapshot.components[id]).toBeDefined();
    }
  });

  it("keeps every pinned system operational when no active incident references it", () => {
    for (const id of ["3", "91", "6", "36", "78"]) {
      expect(snapshot.components[id].state).toBe("OPERATIONAL");
    }
  });

  it("routes a future maintenance to maintenances without flipping the component", () => {
    expect(snapshot.maintenances).toHaveLength(1);
    const maintenance = snapshot.maintenances[0];
    expect(maintenance.state).toBe("scheduled");
    expect(maintenance.componentIds).toEqual(["6"]);
    expect(snapshot.components["6"].state).toBe("OPERATIONAL");
  });

  it("emits a resolved history incident with its resolved timestamp and mapped updates", () => {
    expect(snapshot.incidents).toHaveLength(1);
    const incident = snapshot.incidents[0];
    expect(incident.state).toBe("resolved");
    expect(incident.resolvedAt).toBe("2026-07-10T09:30:00+00:00");
    expect(incident.componentIds).toEqual(["91"]);
    expect(incident.canonicalUrl).toBe("https://status.hetzner.com/");
    expect(incident.updates.map((update) => update.state)).toEqual(["in_progress", "resolved"]);
  });
});

describe("nextdataEmbeddedAdapter.normalize active incident", () => {
  const snapshot = normalize(readFixture("active-incident.html"));

  it("flips a component to OUTAGE when an active outage references its system", () => {
    expect(snapshot.components["91"].state).toBe("OUTAGE");
  });

  it("flips a component to DEGRADED when an active other-type advisory references its system", () => {
    expect(snapshot.components["3"].state).toBe("DEGRADED");
  });

  it("flips a component to MAINTENANCE when an in-progress maintenance references its system", () => {
    expect(snapshot.components["36"].state).toBe("MAINTENANCE");
  });

  it("leaves unreferenced systems operational", () => {
    expect(snapshot.components["6"].state).toBe("OPERATIONAL");
    expect(snapshot.components["78"].state).toBe("OPERATIONAL");
  });

  it("maps a plain Hetzner update note onto monitoring", () => {
    const outage = snapshot.incidents.find((incident) => incident.componentIds.includes("91"))!;
    expect(outage.state).toBe("in_progress");
    expect(outage.updates.map((update) => update.state)).toEqual(["identified", "monitoring"]);
  });

  it("keeps the maintenance-type item out of incidents and in maintenances", () => {
    expect(snapshot.incidents.every((incident) => !incident.componentIds.includes("36"))).toBe(true);
    const maintenance = snapshot.maintenances.find((entry) => entry.componentIds.includes("36"))!;
    expect(maintenance.state).toBe("in_progress");
  });
});

describe("nextdataEmbeddedAdapter.normalize failure modes", () => {
  it("fails to a keep-last-state error when the __NEXT_DATA__ tag is missing", () => {
    expect(() => normalize(readFixture("missing-script.html"))).toThrow(AdapterParseError);
    try {
      normalize(readFixture("missing-script.html"));
    } catch (error) {
      expect((error as AdapterParseError).code).toBe("MISSING_DOCUMENT");
    }
  });

  it("fails when the extracted payload exceeds the strict byte cap", () => {
    const oversized = `<!doctype html><body><script id="__NEXT_DATA__" type="application/json">${"x".repeat(MAX_NEXT_DATA_BYTES + 1)}</script></body>`;
    expect(() => extractNextDataSlice(oversized, source.id)).toThrow(AdapterParseError);
    try {
      extractNextDataSlice(oversized, source.id);
    } catch (error) {
      expect((error as AdapterParseError).code).toBe("SCHEMA_INVALID");
    }
  });

  it("fails on a present tag whose contents are not valid JSON", () => {
    const broken = `<!doctype html><body><script id="__NEXT_DATA__" type="application/json">{not json}</script></body>`;
    try {
      normalize(broken);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError);
      expect((error as AdapterParseError).code).toBe("SCHEMA_INVALID");
    }
  });
});
