import { describe, expect, it, vi } from "vitest"

// persist.ts is server-only. This adapter test reaches into it purely to
// verify the catalog preset's selector and scope resolve a region-scoped
// install to the right state, so the server-only guard is stubbed the same
// way persist.test.ts stubs it.
vi.mock("server-only", () => ({}))

import { loadCatalogManifest } from "../manifest"
import { combinedComponentStates, resolveDependencyState } from "../persist"

import { auth0StatusAdapter } from "./auth0-status"
import authAffected from "./fixtures/auth0/auth-affected.json"
import maintenance from "./fixtures/auth0/maintenance.json"
import operational from "./fixtures/auth0/operational.json"
import privateIncident from "./fixtures/auth0/private-incident.json"
import singleIncident from "./fixtures/auth0/single-incident.json"
import type { AdapterDocument } from "./index"
import { AdapterParseError } from "./shared"

const manifest = loadCatalogManifest()
const source = manifest.sources.find((s) => s.id === "auth0")!
const preset = manifest.presets.find((p) => p.id === "auth0_authentication")!

const REGIONS = [
  "US-1",
  "US-3",
  "US-4",
  "US-5",
  "EU-1",
  "EU-2",
  "AU",
  "JP-1",
  "UK-1",
  "CA-1",
]

// The real transport is the homepage HTML with an embedded __NEXT_DATA__ script
// tag. Fixtures store the sanitized payload, wrapped here in the exact markup
// the adapter's extractor matches, so extraction is exercised end to end.
function htmlWith(payload: unknown): AdapterDocument {
  const body = `<!doctype html><html><head><title>Auth0 Status</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`
  return { kind: "current", url: source.currentUrl, text: body }
}

function normalize(payload: unknown, observedAt = "2026-07-20T10:15:00.000Z") {
  return auth0StatusAdapter.normalize({
    source,
    documents: [htmlWith(payload)],
    observedAt,
  })
}

describe("auth0StatusAdapter.requests", () => {
  it("requests the homepage once in text mode, the only transport carrying incident state", () => {
    expect(auth0StatusAdapter.requests(source)).toEqual([
      {
        kind: "current",
        url: source.currentUrl,
        optional: false,
        mode: "text",
      },
    ])
  })
})

describe("auth0StatusAdapter.normalize: all operational", () => {
  it("maps every stable region to OPERATIONAL and emits no incidents", () => {
    const snapshot = normalize(operational)
    expect(Object.keys(snapshot.components).sort()).toEqual([...REGIONS].sort())
    for (const region of REGIONS) {
      expect(snapshot.components[region]).toMatchObject({
        state: "OPERATIONAL",
      })
    }
    expect(snapshot.incidents).toEqual([])
    expect(snapshot.maintenances).toEqual([])
    expect(snapshot.componentsComplete).toBe(true)
    expect(snapshot.incidentsComplete).toBe(true)
    expect(snapshot.providerUpdatedAt).toBe("2026-07-20T10:00:00.000Z")
  })

  it("resolves a region-scoped preset install to its own region state", () => {
    const snapshot = normalize(operational)
    const combined = combinedComponentStates(snapshot)
    expect(
      resolveDependencyState(preset.selector, "US-1", combined, snapshot)
    ).toBe("OPERATIONAL")
    expect(
      resolveDependencyState(preset.selector, "EU-2", combined, snapshot)
    ).toBe("OPERATIONAL")
  })
})

describe("auth0StatusAdapter.normalize: single region incident", () => {
  it("colors only the affected region and emits one incident scoped to it", () => {
    const snapshot = normalize(singleIncident)
    expect(snapshot.components["EU-1"]).toMatchObject({ state: "OUTAGE" })
    for (const region of REGIONS.filter((r) => r !== "EU-1")) {
      expect(snapshot.components[region]).toMatchObject({
        state: "OPERATIONAL",
      })
    }
    expect(snapshot.incidents).toHaveLength(1)
    const incident = snapshot.incidents[0]!
    expect(incident).toMatchObject({
      externalId: "inc_eu1_9x2",
      title: "Elevated authentication error rates",
      state: "investigating",
      impact: "major",
      resolvedAt: null,
      canonicalUrl: null,
      scope: { kind: "components", componentIds: ["EU-1"] },
    })
    expect(incident.startedAt).toBe("2026-07-20T09:45:00.000Z")
  })

  it("resolves the scoped install to OUTAGE for the affected region only", () => {
    const snapshot = normalize(singleIncident)
    const combined = combinedComponentStates(snapshot)
    expect(
      resolveDependencyState(preset.selector, "EU-1", combined, snapshot)
    ).toBe("OUTAGE")
    expect(
      resolveDependencyState(preset.selector, "US-1", combined, snapshot)
    ).toBe("OPERATIONAL")
  })
})

describe("auth0StatusAdapter.normalize: authenticationAffected surfacing", () => {
  it("aggregates one incident across every affected region and surfaces authenticationAffected in the update body", () => {
    const snapshot = normalize(authAffected)
    expect(snapshot.components["US-1"]).toMatchObject({ state: "OUTAGE" })
    expect(snapshot.components["US-3"]).toMatchObject({ state: "OUTAGE" })
    expect(snapshot.incidents).toHaveLength(1)
    const incident = snapshot.incidents[0]!
    expect(incident.externalId).toBe("inc_multi_c4")
    expect(incident.impact).toBe("critical")
    expect(incident.scope.kind).toBe("components")
    if (incident.scope.kind !== "components") {
      throw new Error("expected components scope")
    }
    expect([...incident.scope.componentIds].sort()).toEqual(["US-1", "US-3"])
    expect(incident.updates).toHaveLength(1)
    // authenticationAffected is true in the US-1 leg, so the OR across regions
    // reports it affected.
    expect(incident.updates[0]!.bodyText).toBe(
      "Authentication affected: yes. Impact: critical."
    )
    expect(incident.updates[0]!.state).toBe("identified")
  })

  it("reports authentication not affected when no region flags it", () => {
    // single-incident's EU-1 leg does flag authentication, so use a payload
    // where it is false: reuse maintenance path is separate, so assert on the
    // structured field directly through a crafted payload.
    const body = JSON.parse(JSON.stringify(singleIncident))
    body.props.pageProps.activeIncidents.find(
      (r: { region: string }) => r.region === "EU-1"
    ).response.incidents[0].authenticationAffected = false
    const recomputed = normalize(body)
    expect(recomputed.incidents[0]!.updates[0]!.bodyText).toBe(
      "Authentication affected: no. Impact: major."
    )
  })
})

describe("auth0StatusAdapter.normalize: maintenance", () => {
  it("routes a scheduled window to maintenances and marks the region MAINTENANCE", () => {
    const snapshot = normalize(maintenance)
    expect(snapshot.components["JP-1"]).toMatchObject({ state: "MAINTENANCE" })
    expect(snapshot.incidents).toEqual([])
    expect(snapshot.maintenances).toHaveLength(1)
    expect(snapshot.maintenances[0]).toMatchObject({
      externalId: "maint_jp1_m7",
      state: "scheduled",
      startsAt: "2026-07-21T02:00:00.000Z",
      componentIds: ["JP-1"],
    })
    const combined = combinedComponentStates(snapshot)
    expect(
      resolveDependencyState(preset.selector, "JP-1", combined, snapshot)
    ).toBe("MAINTENANCE")
  })
})

describe("auth0StatusAdapter.normalize: private incidents", () => {
  it("ignores a tenant-private incident for both state and the incident list", () => {
    const snapshot = normalize(privateIncident)
    expect(snapshot.components.AU).toMatchObject({ state: "OPERATIONAL" })
    expect(snapshot.incidents).toEqual([])
  })
})

describe("auth0StatusAdapter.normalize: terminal lifecycle and synthetic update timestamps", () => {
  it("pins the synthetic :active update createdAt to the stable start and updatedAt to the latest provider time", () => {
    const snapshot = normalize(authAffected)
    const update = snapshot.incidents[0]!.updates[0]!
    expect(update.externalId).toBe("inc_multi_c4:active")
    // Winning leg is US-3 at 08:31 (later than US-1). startedAt falls back to
    // that leg's updated_at when no scheduled_for/monitoring_at is present.
    expect(update.createdAt).toBe(snapshot.incidents[0]!.startedAt)
    expect(update.updatedAt).toBe("2026-07-20T08:31:00.000Z")
    expect(update.createdAt).toBe("2026-07-20T08:31:00.000Z")
  })

  it("maps postmortem to resolved, sets resolvedAt, and does not color the region", () => {
    const body = JSON.parse(JSON.stringify(singleIncident))
    const eu1 = body.props.pageProps.activeIncidents.find(
      (r: { region: string }) => r.region === "EU-1"
    )
    eu1.response.incidents[0].status = "postmortem"
    // monitoring_at anchors startedAt so resolved_at can land after start.
    eu1.response.incidents[0].monitoring_at = "2026-07-20T09:40:00.000Z"
    eu1.response.incidents[0].resolved_at = "2026-07-20T09:50:00.000Z"
    eu1.response.incidents[0].updated_at = "2026-07-20T09:55:00.000Z"
    const snapshot = normalize(body)
    expect(snapshot.components["EU-1"]).toMatchObject({ state: "OPERATIONAL" })
    expect(snapshot.incidents).toHaveLength(1)
    expect(snapshot.incidents[0]!.state).toBe("resolved")
    expect(snapshot.incidents[0]!.startedAt).toBe("2026-07-20T09:40:00.000Z")
    expect(snapshot.incidents[0]!.resolvedAt).toBe("2026-07-20T09:50:00.000Z")
  })

  it("uses updated_at as resolvedAt for a terminal entry without resolved_at", () => {
    const body = JSON.parse(JSON.stringify(singleIncident))
    const eu1 = body.props.pageProps.activeIncidents.find(
      (r: { region: string }) => r.region === "EU-1"
    )
    eu1.response.incidents[0].status = "resolved"
    eu1.response.incidents[0].resolved_at = null
    eu1.response.incidents[0].updated_at = "2026-07-20T09:58:00.000Z"
    const snapshot = normalize(body)
    expect(snapshot.incidents[0]!.resolvedAt).toBe("2026-07-20T09:58:00.000Z")
    expect(snapshot.components["EU-1"]!.state).toBe("OPERATIONAL")
  })
})

describe("auth0StatusAdapter.normalize: transport and parse failures resolve to UNKNOWN, never OUTAGE", () => {
  it("throws AdapterParseError when the homepage has no __NEXT_DATA__ payload", () => {
    const doc: AdapterDocument = {
      kind: "current",
      url: source.currentUrl,
      text: "<html><body>maintenance mode</body></html>",
    }
    expect(() =>
      auth0StatusAdapter.normalize({
        source,
        documents: [doc],
        observedAt: "2026-07-20T10:00:00.000Z",
      })
    ).toThrow(AdapterParseError)
  })

  it("throws SCHEMA_INVALID when the embedded payload is not valid JSON", () => {
    const doc: AdapterDocument = {
      kind: "current",
      url: source.currentUrl,
      text: `<script id="__NEXT_DATA__" type="application/json">{not valid json}</script>`,
    }
    try {
      auth0StatusAdapter.normalize({
        source,
        documents: [doc],
        observedAt: "2026-07-20T10:00:00.000Z",
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError)
      expect((error as AdapterParseError).code).toBe("SCHEMA_INVALID")
    }
  })

  it("throws MISSING_DOCUMENT when no current text document was fetched", () => {
    expect(() =>
      auth0StatusAdapter.normalize({
        source,
        documents: [],
        observedAt: "2026-07-20T10:00:00.000Z",
      })
    ).toThrow(AdapterParseError)
  })

  it("throws on an unrecognized incident status rather than mislabeling it", () => {
    const body = JSON.parse(JSON.stringify(singleIncident))
    body.props.pageProps.activeIncidents.find(
      (r: { region: string }) => r.region === "EU-1"
    ).response.incidents[0].status = "smoldering"
    try {
      normalize(body)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError)
      expect((error as AdapterParseError).code).toBe("UNKNOWN_STATUS")
    }
  })

  it("resolves a region the successful feed no longer enumerates to UNKNOWN under a complete snapshot", () => {
    const snapshot = normalize(operational)
    const combined = combinedComponentStates(snapshot)
    // A scope option that is absent from the enumerated regions resolves to
    // UNKNOWN because componentsComplete is true, never to a fabricated OUTAGE.
    expect(
      resolveDependencyState(preset.selector, "ZZ-9", combined, snapshot)
    ).toBe("UNKNOWN")
  })
})
