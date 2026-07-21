import { describe, expect, it } from "vitest"

import { loadCatalogManifest } from "../manifest"

import degraded from "./fixtures/anthropic/degraded.json"
import incidentsPostmortem from "./fixtures/anthropic/incidents-postmortem.json"
import incidentsResolved from "./fixtures/anthropic/incidents-resolved.json"
import maintenance from "./fixtures/anthropic/maintenance.json"
import malformed from "./fixtures/anthropic/malformed.json"
import missingComponent from "./fixtures/anthropic/missing-component.json"
import operational from "./fixtures/anthropic/operational.json"
import outage from "./fixtures/anthropic/outage.json"
import type { AdapterDocument } from "./index"
import { AdapterParseError } from "./shared"
import { statuspageV2Adapter } from "./statuspage-v2"

const manifest = loadCatalogManifest()
const anthropicSource = manifest.sources.find(
  (source) => source.id === "anthropic"
)!
const anthropicApiPreset = manifest.presets.find(
  (preset) => preset.id === "anthropic_api"
)!

function currentDoc(json: unknown): AdapterDocument {
  return { kind: "current", url: anthropicSource.currentUrl, json }
}

function incidentsDoc(json: unknown): AdapterDocument {
  return { kind: "incidents", url: anthropicSource.incidentsUrl!, json }
}

describe("statuspageV2Adapter.requests", () => {
  it("always requests current, and marks incidents and maintenance as optional", () => {
    const requests = statuspageV2Adapter.requests(anthropicSource)
    expect(
      requests.find((request) => request.kind === "current")
    ).toMatchObject({ url: anthropicSource.currentUrl, optional: false })
    expect(
      requests.find((request) => request.kind === "incidents")
    ).toMatchObject({ optional: true })
    expect(
      requests.find((request) => request.kind === "maintenance")
    ).toMatchObject({ optional: true })
  })
})

describe("statuspageV2Adapter.normalize: component status mapping", () => {
  it("maps operational", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(operational)],
      observedAt: "2026-07-19T15:00:00Z",
    })
    expect(snapshot.components["k8w3r06qmzrp"]).toMatchObject({
      state: "OPERATIONAL",
    })
  })

  it("maps degraded_performance to DEGRADED", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(degraded)],
      observedAt: "2026-07-19T15:10:00Z",
    })
    expect(snapshot.components["k8w3r06qmzrp"]).toMatchObject({
      state: "DEGRADED",
    })
  })

  it("maps major_outage to OUTAGE", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(outage)],
      observedAt: "2026-07-19T16:00:00Z",
    })
    expect(snapshot.components["k8w3r06qmzrp"]).toMatchObject({
      state: "OUTAGE",
    })
    expect(snapshot.components["rwppv331jlwc"]).toMatchObject({
      state: "OUTAGE",
    })
  })

  it("maps under_maintenance to MAINTENANCE", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(maintenance)],
      observedAt: "2026-07-19T02:30:00Z",
    })
    expect(snapshot.components["k8w3r06qmzrp"]).toMatchObject({
      state: "MAINTENANCE",
    })
  })

  it("maps the scheduled-maintenance verifying status onto the monitoring incident state", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(maintenance)],
      observedAt: "2026-07-19T02:30:00Z",
    })
    const verifying = snapshot.maintenances.find(
      (entry) => entry.externalId === "samplemaint02"
    )
    expect(verifying?.state).toBe("monitoring")
    const inProgress = snapshot.maintenances.find(
      (entry) => entry.externalId === "samplemaint01"
    )
    expect(inProgress?.state).toBe("in_progress")
  })
})

describe("statuspageV2Adapter.normalize: component selection against the catalog", () => {
  it("selects the anthropic_api preset's Claude API component by its real upstream id", () => {
    expect(anthropicApiPreset.selector).toMatchObject({
      kind: "component_ids",
      ids: ["k8w3r06qmzrp"],
    })
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(outage)],
      observedAt: "2026-07-19T16:00:00Z",
    })
    const ids =
      anthropicApiPreset.selector.kind === "component_ids"
        ? anthropicApiPreset.selector.ids
        : []
    const states = ids.map((id) => snapshot.components[id]?.state)
    expect(states).toEqual(["OUTAGE"])
  })
})

describe("statuspageV2Adapter.normalize: incidents", () => {
  it("falls back to the incidents.json document for full incident and update history", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(operational), incidentsDoc(incidentsResolved)],
      observedAt: "2026-07-17T20:00:00Z",
    })
    expect(snapshot.incidents).toHaveLength(1)
    const [incident] = snapshot.incidents
    expect(incident.externalId).toBe("g613ntyj2pwf")
    expect(incident.state).toBe("resolved")
    expect(incident.resolvedAt).toBe("2026-07-17T19:43:35.467Z")
    expect(incident.scope).toEqual({
      kind: "components",
      componentIds: expect.arrayContaining(["k8w3r06qmzrp"]),
    })
    expect(incident.updates.map((update) => update.state)).toEqual([
      "resolved",
      "monitoring",
      "identified",
      "investigating",
    ])
  })

  it("maps a postmortem incident and its postmortem update onto resolved, preserving resolved_at", () => {
    // WorkOS and Upstash publish post-incident retrospectives, so their live
    // incidents.json carries incidents whose status is the standard Atlassian
    // Statuspage "postmortem" lifecycle value plus incident_updates in the same
    // status. "postmortem" is not in the 9-value provider vocabulary, so without
    // a mapping requireProviderIncidentState throws UNKNOWN_STATUS and fails the
    // whole source. It normalizes to resolved: the incident is closed and every
    // postmortem incident carries resolved_at.
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(operational), incidentsDoc(incidentsPostmortem)],
      observedAt: "2026-07-15T13:00:00Z",
    })
    expect(snapshot.incidents).toHaveLength(1)
    const [incident] = snapshot.incidents
    expect(incident.externalId).toBe("pm7x3incident01")
    expect(incident.state).toBe("resolved")
    expect(incident.resolvedAt).toBe("2026-07-14T19:43:35.467Z")
    expect(incident.updates.map((update) => update.state)).toEqual([
      "resolved",
      "resolved",
      "investigating",
    ])
  })

  it("uses summary.json's inline incidents when no incidents.json document is fetched", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(degraded)],
      observedAt: "2026-07-19T15:10:00Z",
    })
    expect(snapshot.incidents).toHaveLength(1)
    expect(snapshot.incidents[0].externalId).toBe("sample1degraded01")
  })

  it("deep-links canonicalUrl to the incident permalink on the source's own host, not the shared stspg.io shortlink", () => {
    // The fixture's shortlink is https://stspg.io/... on the shared Statuspage
    // shortener, a host in no source's allowedHosts. The adapter instead emits
    // the incident permalink under the source's own status page host so
    // safeProviderUrl preserves it and the deep link survives.
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(degraded)],
      observedAt: "2026-07-19T15:10:00Z",
    })
    expect(snapshot.incidents[0].canonicalUrl).toBe(
      "https://status.claude.com/incidents/sample1degraded01"
    )
    expect(snapshot.incidents[0].canonicalUrl).not.toContain("stspg.io")
    expect(new URL(snapshot.incidents[0].canonicalUrl!).hostname).toBe(
      new URL(anthropicSource.statusPageUrl).hostname
    )
  })

  it("strips HTML and caps update bodies", () => {
    const withHtml = JSON.parse(JSON.stringify(degraded))
    withHtml.incidents[0].incident_updates[0].body =
      "<p>A fix has <strong>been applied</strong>.</p>"
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(withHtml)],
      observedAt: "2026-07-19T15:10:00Z",
    })
    expect(
      snapshot.incidents[0].updates.find(
        (update) => update.externalId === "sample1degraded01-u2"
      )?.bodyText
    ).toBe("A fix has been applied .")
  })

  it("normalizing the same fixture twice yields identical incident and update external ids", () => {
    const first = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(operational), incidentsDoc(incidentsResolved)],
      observedAt: "2026-07-17T20:00:00Z",
    })
    const second = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(operational), incidentsDoc(incidentsResolved)],
      observedAt: "2026-07-17T20:05:00Z",
    })
    expect(first.incidents.map((incident) => incident.externalId)).toEqual(
      second.incidents.map((incident) => incident.externalId)
    )
    expect(
      first.incidents[0].updates.map((update) => update.externalId)
    ).toEqual(second.incidents[0].updates.map((update) => update.externalId))
  })
})

describe("statuspageV2Adapter.normalize: incidentsComplete", () => {
  it("is complete from summary.json alone, so a skipped incidents.json never false-closes an open incident", () => {
    // summary.json authoritatively lists active incidents inline, so the open
    // set is complete even on a cycle where the optional incidents.json was not
    // fetched and normalize() fell back to summary.incidents.
    const fromSummaryOnly = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(degraded)],
      observedAt: "2026-07-19T15:10:00Z",
    })
    expect(fromSummaryOnly.incidentsComplete).toBe(true)
    const withIncidentsDoc = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(operational), incidentsDoc(incidentsResolved)],
      observedAt: "2026-07-17T20:00:00Z",
    })
    expect(withIncidentsDoc.incidentsComplete).toBe(true)
  })
})

describe("statuspageV2Adapter.normalize: failure handling", () => {
  it("throws AdapterParseError on an unrecognized top-level shape", () => {
    expect(() =>
      statuspageV2Adapter.normalize({
        source: anthropicSource,
        documents: [currentDoc(malformed)],
        observedAt: "2026-07-19T15:00:00Z",
      })
    ).toThrow(AdapterParseError)
  })

  it("does not throw when the feed omits a catalog component, it is simply absent from the snapshot", () => {
    const snapshot = statuspageV2Adapter.normalize({
      source: anthropicSource,
      documents: [currentDoc(missingComponent)],
      observedAt: "2026-07-19T15:00:00Z",
    })
    expect(snapshot.components["k8w3r06qmzrp"]).toBeUndefined()
    // componentsComplete true (FIX B): a successful summary.json enumerates
    // every component, so this absence resolves the dependency to UNKNOWN,
    // not OPERATIONAL.
    expect(snapshot.componentsComplete).toBe(true)
  })

  it("throws MISSING_DOCUMENT when the current document was never fetched", () => {
    try {
      statuspageV2Adapter.normalize({
        source: anthropicSource,
        documents: [],
        observedAt: "2026-07-19T15:00:00Z",
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError)
      expect((error as AdapterParseError).code).toBe("MISSING_DOCUMENT")
    }
  })
})
