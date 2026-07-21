import { describe, expect, it, vi } from "vitest"

// The registry pulls in every adapter, and some (incident_feed via xml.ts)
// transitively import the server-only guard. This suite exercises pure
// registry wiring in the test runner, so the guard is stubbed out.
vi.mock("server-only", () => ({}))

import { loadCatalogManifest } from "../manifest"

import { adapterRegistry } from "./index"

describe("adapterRegistry", () => {
  it("resolves every adapter name referenced by a catalog.json source", () => {
    const manifest = loadCatalogManifest()
    for (const source of manifest.sources) {
      const adapter = adapterRegistry[source.adapter]
      expect(adapter).toBeDefined()
      expect(typeof adapter?.requests).toBe("function")
      expect(typeof adapter?.normalize).toBe("function")
      expect(typeof adapter?.catalogDirectory).toBe("function")
    }
  })

  it("has exactly the documented adapters wired into the registry, no more and no less", () => {
    expect(Object.keys(adapterRegistry).sort()).toEqual([
      "auth0_status",
      "aws_health",
      "google_cloud_status",
      "incident_feed",
      "incidentio_compat",
      "nextdata_embedded",
      "sorry_v1",
      "statusio_public",
      "statuspage_v2",
    ])
  })
})
