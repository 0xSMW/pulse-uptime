import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { loadCatalogManifest } from "../manifest"
import {
  incidentFeedAdapter,
  parseIncidentFeedUpdateMarker,
  requireIncidentInventory,
} from "./incident-feed"
import type { AdapterDocument } from "./index"
import { AdapterParseError } from "./shared"

// The catalog pins OpenRouter to this adapter. Loading it here keeps the suite
// honest against the shipped source and preset rather than a hand-built stub.
const manifest = loadCatalogManifest()
const source = manifest.sources.find((entry) => entry.id === "openrouter")!
const preset = manifest.presets.find((entry) => entry.id === "openrouter_api")!

const OBSERVED_AT = "2026-07-20T10:11:46.000Z"

function fixture(name: string): string {
  return readFileSync(
    new URL(`./fixtures/openrouter/${name}`, import.meta.url),
    "utf8"
  )
}

function normalizeFixture(name: string) {
  const document: AdapterDocument = {
    kind: "current",
    url: source.currentUrl,
    text: fixture(name),
  }
  return incidentFeedAdapter.normalize({
    source,
    documents: [document],
    observedAt: OBSERVED_AT,
  })
}

describe("OpenRouter catalog wiring", () => {
  it("routes OpenRouter through the incident_feed adapter with incident_only fidelity", () => {
    expect(source.adapter).toBe("incident_feed")
    expect(source.fidelity).toBe("incident_only")
    expect(source.currentUrl).toBe("https://status.openrouter.ai/incidents.rss")
    expect(source.allowedHosts).toContain("status.openrouter.ai")
  })

  it("ships the openrouter_api preset as incident_only in the ai category", () => {
    expect(preset.sourceId).toBe("openrouter")
    expect(preset.category).toBe("ai")
    expect(preset.fidelity).toBe("incident_only")
  })
})

describe("incidentFeedAdapter.requests", () => {
  it("asks for a single raw-text current document", () => {
    const requests = incidentFeedAdapter.requests(source)
    expect(requests).toEqual([
      {
        kind: "current",
        url: source.currentUrl,
        optional: false,
        mode: "text",
      },
    ])
  })
})

describe("incidentFeedAdapter.catalogDirectory", () => {
  it("declares a complete directory that tracks no components", () => {
    // Presets like openrouter_api select the synthetic "incident-feed" id.
    // tracksComponents false is what keeps catalog reconcile from disabling
    // them for component-id drift against the empty inventory.
    const document: AdapterDocument = {
      kind: "current",
      url: source.currentUrl,
      text: fixture("empty.rss"),
    }
    const directory = incidentFeedAdapter.catalogDirectory({
      source,
      documents: [document],
    })
    expect(directory.complete).toBe(true)
    expect(directory.tracksComponents).toBe(false)
    expect(directory.componentIds.size).toBe(0)
  })
})

describe("incidentFeedAdapter.normalize", () => {
  it("reports an empty feed as operational with no incidents and no component claims", () => {
    const snapshot = normalizeFixture("empty.rss")
    expect(snapshot.incidents).toEqual([])
    expect(snapshot.components).toEqual({})
    // Empty components plus componentsComplete true is what makes an idle
    // incident_only preset resolve to UNKNOWN, never a fabricated OPERATIONAL.
    expect(snapshot.componentsComplete).toBe(true)
    // OpenRouter is rolling_history: absence is never resolution.
    expect(source.config.incidentInventory).toBe("rolling_history")
    expect(snapshot.incidentsComplete).toBe(false)
    expect(snapshot.providerUpdatedAt).toBeNull()
    expect(snapshot.maintenances).toEqual([])
  })

  it("surfaces an active incident as unresolved with no component identity", () => {
    const snapshot = normalizeFixture("active-incident.rss")
    const active = snapshot.incidents.find(
      (incident) =>
        incident.externalId === "status.openrouter.ai/incidents/aBc123XyZ"
    )!
    expect(active.state).toBe("identified")
    expect(active.resolvedAt).toBeNull()
    // No structured component identity: an active incident is a source-wide signal.
    expect(active.scope).toEqual({ kind: "source" })
    expect(active.startedAt).toBe("2026-07-15T08:50:00.000Z")
    expect(active.canonicalUrl).toBe(
      "https://status.openrouter.ai/incidents/aBc123XyZ"
    )

    // The historical entry in the same feed is read as resolved from its own marker.
    const historical = snapshot.incidents.find(
      (incident) =>
        incident.externalId === "status.openrouter.ai/incidents/Old999Prev"
    )!
    expect(historical.state).toBe("resolved")
    expect(historical.resolvedAt).not.toBeNull()

    // providerUpdatedAt is the newest entry's timestamp.
    expect(snapshot.providerUpdatedAt).toBe("2026-07-15T08:50:00.000Z")
  })

  it("marks a resolved incident and a completed maintenance as closed", () => {
    const snapshot = normalizeFixture("resolved-incident.rss")
    const incident = snapshot.incidents.find(
      (entry) =>
        entry.externalId === "status.openrouter.ai/incidents/Res456Done"
    )!
    expect(incident.state).toBe("resolved")
    expect(incident.resolvedAt).toBe("2026-07-06T05:30:00.000Z")

    const maintenance = snapshot.incidents.find(
      (entry) =>
        entry.externalId === "status.openrouter.ai/incidents/Mnt0DVmalJZ"
    )!
    expect(maintenance.state).toBe("completed")
    expect(maintenance.resolvedAt).not.toBeNull()

    // Every entry is closed, so no active unresolved incident remains.
    expect(snapshot.incidents.every((entry) => entry.resolvedAt !== null)).toBe(
      true
    )
  })

  it("displays incident prose verbatim as bounded, markup-stripped update text", () => {
    const snapshot = normalizeFixture("active-incident.rss")
    const active = snapshot.incidents.find(
      (incident) =>
        incident.externalId === "status.openrouter.ai/incidents/aBc123XyZ"
    )!
    expect(active.updates).toHaveLength(1)
    const update = active.updates[0]!
    expect(update.bodyText).toContain(
      "IDENTIFIED - We have identified the cause"
    )
    // Markup is stripped, never carried through as raw HTML.
    expect(update.bodyText).not.toContain("<")
    expect(update.state).toBe("identified")
  })

  it("dedups repeated guids, keeping the newest pubDate", () => {
    const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Old text</title><guid>dup-1</guid><pubDate>Mon, 06 Jul 2026 05:00:00 GMT</pubDate>
    <description>INVESTIGATING - old body</description></item>
  <item><title>New text</title><guid>dup-1</guid><pubDate>Mon, 06 Jul 2026 09:00:00 GMT</pubDate>
    <description>RESOLVED - the newer state</description></item>
</channel></rss>`
    const snapshot = incidentFeedAdapter.normalize({
      source,
      documents: [{ kind: "current", url: source.currentUrl, text: feed }],
      observedAt: OBSERVED_AT,
    })
    expect(snapshot.incidents).toHaveLength(1)
    expect(snapshot.incidents[0]!.title).toBe("New text")
    expect(snapshot.incidents[0]!.state).toBe("resolved")
  })

  it("throws on a document that is not a feed rather than reading it as operational", () => {
    expect(() => normalizeFixture("malformed.rss")).toThrow(AdapterParseError)
    try {
      normalizeFixture("malformed.rss")
    } catch (error) {
      expect((error as AdapterParseError).code).toBe("SCHEMA_INVALID")
    }
  })

  it("rejects an entity-bomb feed through the shared parser", () => {
    expect(() => normalizeFixture("entity-bomb.rss")).toThrow(AdapterParseError)
    try {
      normalizeFixture("entity-bomb.rss")
    } catch (error) {
      expect((error as AdapterParseError).code).toBe("SCHEMA_INVALID")
    }
  })

  it("throws when the poller hands it no document", () => {
    expect(() =>
      incidentFeedAdapter.normalize({
        source,
        documents: [],
        observedAt: OBSERVED_AT,
      })
    ).toThrow(AdapterParseError)
  })
})

// Azure rides the incident_feed adapter unchanged. Its feed is provider-wide
// and active-incident-only: quiet, often a completely empty channel, and it
// never exposes per-component health. These cases pin that the shared adapter
// reads the empty channel as operational and displays a real incident verbatim.
const azureSource = manifest.sources.find((entry) => entry.id === "azure")!
const azurePreset = manifest.presets.find(
  (entry) => entry.id === "azure_platform"
)!

function azureFixture(name: string): string {
  return readFileSync(
    new URL(`./fixtures/azure/${name}`, import.meta.url),
    "utf8"
  )
}

function normalizeAzure(name: string) {
  const document: AdapterDocument = {
    kind: "current",
    url: azureSource.currentUrl,
    text: azureFixture(name),
  }
  return incidentFeedAdapter.normalize({
    source: azureSource,
    documents: [document],
    observedAt: OBSERVED_AT,
  })
}

describe("Azure catalog wiring", () => {
  it("routes Azure through the incident_feed adapter with incident_only fidelity", () => {
    expect(azureSource.provider).toBe("Azure")
    expect(azureSource.adapter).toBe("incident_feed")
    expect(azureSource.fidelity).toBe("incident_only")
    expect(azureSource.currentUrl).toBe(
      "https://azure.status.microsoft/en-us/status/feed/"
    )
    expect(azureSource.allowedHosts).toContain("azure.status.microsoft")
    expect(azureSource.allowedHosts).toContain("rssfeed.azure.status.microsoft")
    expect(azureSource.allowedHosts).toContain("azurestatuscdn.azureedge.net")
    // Active-only inventory: a successful empty channel closes open incidents.
    expect(azureSource.config.incidentInventory).toBe("active_only")
  })

  it("ships the azure_platform preset as incident_only in the hosting category", () => {
    expect(azurePreset.sourceId).toBe("azure")
    expect(azurePreset.category).toBe("hosting")
    expect(azurePreset.fidelity).toBe("incident_only")
  })
})

describe("incidentFeedAdapter.normalize on the Azure feed", () => {
  it("reads the empty Azure channel as a complete snapshot with zero incidents", () => {
    const snapshot = normalizeAzure("empty-channel.rss")
    expect(snapshot.incidents).toEqual([])
    expect(snapshot.components).toEqual({})
    // Empty components plus componentsComplete true keeps an idle incident_only
    // preset at UNKNOWN, never a fabricated OPERATIONAL for a quiet Azure feed.
    expect(snapshot.componentsComplete).toBe(true)
    // active_only: a successful empty channel is an authoritative empty set.
    expect(snapshot.incidentsComplete).toBe(true)
    expect(snapshot.providerUpdatedAt).toBeNull()
    expect(snapshot.maintenances).toEqual([])
  })

  it("surfaces a synthetic Azure incident as active and displays its prose verbatim", () => {
    const snapshot = normalizeAzure("active-incident.rss")
    expect(snapshot.incidents).toHaveLength(1)
    expect(snapshot.incidentsComplete).toBe(true)
    const incident = snapshot.incidents[0]!
    expect(incident.externalId).toBe("VLBP-1S8")
    expect(incident.title).toBe(
      "Azure Service Issue - Virtual Machines - West Europe"
    )
    // Azure carries no Statuspage status marker, so an item present in the
    // active-only feed is an unresolved incident, never a false resolution.
    expect(incident.state).toBe("investigating")
    expect(incident.resolvedAt).toBeNull()
    // No structured component identity: an Azure incident is a source-wide signal.
    expect(incident.scope).toEqual({ kind: "source" })
    expect(incident.startedAt).toBe("2026-07-20T08:50:00.000Z")
    expect(incident.canonicalUrl).toBe(
      "https://azure.status.microsoft/en-us/status"
    )
    expect(incident.updates).toHaveLength(1)
    const update = incident.updates[0]!
    expect(update.bodyText).toBe(
      "Starting at 08:45 UTC on 20 Jul 2026, a subset of customers using Virtual Machines in West Europe may experience connection failures or high latency. Engineers are actively investigating the underlying cause."
    )
    expect(update.bodyText).not.toContain("<")
  })

  it("throws on a malformed Azure document so prior state is held, never an empty complete set", () => {
    const doc: AdapterDocument = {
      kind: "current",
      url: azureSource.currentUrl,
      text: "<html><body>Azure status is temporarily unavailable</body></html>",
    }
    expect(() =>
      incidentFeedAdapter.normalize({
        source: azureSource,
        documents: [doc],
        observedAt: OBSERVED_AT,
      })
    ).toThrow(AdapterParseError)
  })
})

describe("requireIncidentInventory", () => {
  it("reads active_only and rolling_history from catalog sources", () => {
    expect(requireIncidentInventory(azureSource)).toBe("active_only")
    expect(requireIncidentInventory(source)).toBe("rolling_history")
  })

  it("rejects a missing or unknown inventory value", () => {
    expect(() =>
      requireIncidentInventory({ ...azureSource, config: {} })
    ).toThrow(AdapterParseError)
    expect(() =>
      requireIncidentInventory({
        ...azureSource,
        config: { incidentInventory: "guessed" },
      })
    ).toThrow(AdapterParseError)
  })
})

describe("parseIncidentFeedUpdateMarker", () => {
  it("reads RESOLVED at the start of the description", () => {
    expect(parseIncidentFeedUpdateMarker("RESOLVED - All clear.")).toEqual({
      state: "resolved",
      resolved: true,
    })
  })

  it("reads IDENTIFIED immediately after a UTC timezone token", () => {
    expect(
      parseIncidentFeedUpdateMarker(
        "Jul 15, 09:15 UTC IDENTIFIED - Cause found."
      )
    ).toEqual({
      state: "identified",
      resolved: false,
    })
  })

  it("ignores UNRESOLVED, which is not a vocabulary token", () => {
    expect(parseIncidentFeedUpdateMarker("UNRESOLVED - still broken")).toEqual({
      state: "investigating",
      resolved: false,
    })
  })

  it("ignores PREIDENTIFIED, which is not an exact vocabulary token", () => {
    expect(
      parseIncidentFeedUpdateMarker("PREIDENTIFIED - not a real marker")
    ).toEqual({
      state: "investigating",
      resolved: false,
    })
  })

  it("ignores a vocabulary word that only appears mid-body prose", () => {
    expect(
      parseIncidentFeedUpdateMarker(
        "We believe the issue is RESOLVED - please retry. Engineers continue to watch."
      )
    ).toEqual({ state: "investigating", resolved: false })
  })

  it("uses the first valid marker in provider order on multi-segment Statuspage prose", () => {
    const multi =
      "Jul 6, 06:45 UTC RESOLVED - Fixed. Jul 6, 05:30 UTC INVESTIGATING - Looking into it."
    expect(parseIncidentFeedUpdateMarker(multi)).toEqual({
      state: "resolved",
      resolved: true,
    })
  })

  it("parses existing Statuspage RSS prose after markup stripping", () => {
    const statuspage =
      "Jul 15, 09:15 UTC IDENTIFIED - We have identified the cause and are working on a fix. Jul 15, 08:50 UTC INVESTIGATING - We are investigating elevated error rates on the routing API."
    expect(parseIncidentFeedUpdateMarker(statuspage)).toEqual({
      state: "identified",
      resolved: false,
    })
  })

  it("falls back to active when description is empty", () => {
    expect(parseIncidentFeedUpdateMarker(null)).toEqual({
      state: "investigating",
      resolved: false,
    })
    expect(parseIncidentFeedUpdateMarker("")).toEqual({
      state: "investigating",
      resolved: false,
    })
  })
})
