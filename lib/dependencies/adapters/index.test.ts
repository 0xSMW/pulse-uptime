import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import { adapterRegistry } from "./index";

describe("adapterRegistry", () => {
  it("resolves every adapter name referenced by a catalog.json source", () => {
    const manifest = loadCatalogManifest();
    for (const source of manifest.sources) {
      expect(adapterRegistry[source.adapter]).toBeDefined();
      expect(typeof adapterRegistry[source.adapter].requests).toBe("function");
      expect(typeof adapterRegistry[source.adapter].normalize).toBe("function");
    }
  });

  it("has exactly the five documented adapters, no more and no less", () => {
    expect(Object.keys(adapterRegistry).sort()).toEqual([
      "google_cloud_status",
      "incidentio_compat",
      "sorry_v1",
      "statusio_public",
      "statuspage_v2",
    ]);
  });
});
