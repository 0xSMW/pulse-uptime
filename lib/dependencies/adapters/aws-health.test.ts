import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  type FetchResponse,
  fetchProviderDocument,
  type ManagedDispatcher,
} from "../fetch"
import { loadCatalogManifest } from "../manifest"

import { awsHealthAdapter } from "./aws-health"
import degraded from "./fixtures/aws/degraded.json"
import live from "./fixtures/aws/live-currentevents.json"
import malformed from "./fixtures/aws/malformed.json"
import operational from "./fixtures/aws/operational.json"
import unknownStatus from "./fixtures/aws/unknown-status.json"
import type { AdapterDocument } from "./index"
import { AdapterParseError } from "./shared"

// AWS Health's public currentevents feed carries only ACTIVE events, so a
// service with no active event is simply absent from `components` and callers
// read that absence as OPERATIONAL, like google_cloud_status. These suites pin
// the catalog's AWS source and region presets against the observed feed shape
// so a preset can never reference a service id form the live feed does not use.

const manifest = loadCatalogManifest()
const source = manifest.sources.find((entry) => entry.id === "aws")!
const ec2Preset = manifest.presets.find((preset) => preset.id === "aws_ec2")!
const s3Preset = manifest.presets.find((preset) => preset.id === "aws_s3")!
const lambdaPreset = manifest.presets.find(
  (preset) => preset.id === "aws_lambda"
)!
const dynamoPreset = manifest.presets.find(
  (preset) => preset.id === "aws_dynamodb"
)!

function currentDoc(json: unknown): AdapterDocument {
  return { kind: "current", url: source.currentUrl, json }
}

describe("aws catalog source", () => {
  it("uses the aws_health adapter against the utf-16 public currentevents feed", () => {
    expect(source.adapter).toBe("aws_health")
    expect(source.currentUrl).toBe(
      "https://health.aws.amazon.com/public/currentevents"
    )
    expect(source.allowedHosts).toContain("health.aws.amazon.com")
  })

  it("raises the body cap to 2 MB for the large utf-16 feed via the per-source config", () => {
    expect(source.config.maxBodyBytes).toBe(2 * 1024 * 1024)
  })

  it("scopes every region preset with a required region choice mapping to a pinned service id", () => {
    for (const preset of [ec2Preset, s3Preset, lambdaPreset, dynamoPreset]) {
      expect(preset.selector).toMatchObject({ kind: "component_ids", ids: [] })
      expect(preset.scope?.kind).toBe("required_options")
      if (preset.scope?.kind === "required_options") {
        expect(preset.scope.options.length).toBeGreaterThanOrEqual(7)
        // Every option id is the feed's own <servicecode>-<region> service string.
        for (const option of preset.scope.options) {
          expect(option.id).toMatch(/^[a-z0-9]+-[a-z]{2}-[a-z]+-\d$/)
        }
      }
    }
  })
})

describe("awsHealthAdapter.requests", () => {
  it("requests the single currentevents document that serves both current state and incident prose", () => {
    expect(awsHealthAdapter.requests(source)).toEqual([
      { kind: "current", url: source.currentUrl, optional: false },
    ])
  })
})

describe("awsHealthAdapter.normalize: empty feed means all operational", () => {
  it("returns no components and no incidents when the feed is an empty array", () => {
    const snapshot = awsHealthAdapter.normalize({
      source,
      documents: [currentDoc(operational)],
      observedAt: "2026-07-20T12:00:00Z",
    })
    expect(Object.keys(snapshot.components)).toHaveLength(0)
    expect(snapshot.incidents).toHaveLength(0)
    // Absence means operational, so an install pinned to any region reads
    // OPERATIONAL through resolveDependencyState's componentsComplete-false path.
    expect(snapshot.componentsComplete).toBe(false)
  })
})

describe("awsHealthAdapter.normalize: status code mapping", () => {
  const snapshot = awsHealthAdapter.normalize({
    source,
    documents: [currentDoc(degraded)],
    observedAt: "2026-07-20T12:00:00Z",
  })

  it("maps status 2 to DEGRADED for the ec2 service id an aws_ec2 install scopes to", () => {
    const usEast1 =
      ec2Preset.scope?.kind === "required_options"
        ? ec2Preset.scope.options.find(
            (option) => option.label === "us-east-1"
          )!.id
        : ""
    expect(usEast1).toBe("ec2-us-east-1")
    expect(snapshot.components["ec2-us-east-1"]).toMatchObject({
      state: "DEGRADED",
    })
  })

  it("maps status 3 to OUTAGE for the s3 service id an aws_s3 install scopes to", () => {
    expect(snapshot.components["s3-us-east-1"]).toMatchObject({
      state: "OUTAGE",
    })
  })

  it("maps informational status 1 to DEGRADED and keeps its prose in the incident updates", () => {
    expect(snapshot.components["lambda-us-east-1"]).toMatchObject({
      state: "DEGRADED",
    })
    const bodies = snapshot.incidents[0]!.updates.map(
      (update) => update.bodyText
    ).join(" ")
    expect(bodies).toContain("Lambda see degraded performance")
  })

  it("treats a recovered service (current_status 0) as absent, callers read that as OPERATIONAL", () => {
    expect(snapshot.components["dynamodb-us-east-1"]).toBeUndefined()
    expect(dynamoPreset.selector.kind).toBe("component_ids")
  })

  it("carries the ISO-converted change timestamp on the component, converting epoch millis", () => {
    expect(snapshot.components["ec2-us-east-1"]!.updatedAt).toBe(
      "2026-03-03T01:06:40.000Z"
    )
  })
})

describe("awsHealthAdapter.normalize: incident shape", () => {
  const snapshot = awsHealthAdapter.normalize({
    source,
    documents: [currentDoc(degraded)],
    observedAt: "2026-07-20T12:00:00Z",
  })
  const incident = snapshot.incidents[0]!

  it("uses the event arn as the stable incident external id and the summary as the title", () => {
    expect(incident.externalId).toBe(
      "arn:aws:health:us-east-1::event/MULTIPLE_SERVICES/AWS_MULTIPLE_SERVICES_OPERATIONAL_ISSUE/AWS_MULTIPLE_SERVICES_OPERATIONAL_ISSUE_SYNTHETIC_USE1"
    )
    expect(incident.title).toBe("Increased Error Rates in the US-EAST-1 Region")
  })

  it("marks the active event identified with a null resolvedAt and converts the epoch-seconds start time", () => {
    expect(incident.state).toBe("identified")
    expect(incident.resolvedAt).toBeNull()
    expect(incident.startedAt).toBe("2026-03-03T01:06:40.000Z")
  })

  it("only lists currently-impacted service ids on the incident, excluding a recovered one", () => {
    expect(incident.scope.kind).toBe("components")
    if (incident.scope.kind !== "components") {
      throw new Error("expected components scope")
    }
    expect(incident.scope.componentIds).toContain("ec2-us-east-1")
    expect(incident.scope.componentIds).toContain("s3-us-east-1")
    expect(incident.scope.componentIds).toContain("lambda-us-east-1")
    expect(incident.scope.componentIds).not.toContain("dynamodb-us-east-1")
  })

  it("derives stable event_log update identities from their timestamps, idempotent across polls", () => {
    const again = awsHealthAdapter.normalize({
      source,
      documents: [currentDoc(degraded)],
      observedAt: "2026-07-20T12:05:00Z",
    })
    expect(
      snapshot.incidents[0]!.updates.map((update) => update.externalId)
    ).toEqual(again.incidents[0]!.updates.map((update) => update.externalId))
    expect(
      snapshot.incidents[0]!.updates.every(
        (update) => update.state === "identified"
      )
    ).toBe(true)
  })

  it("marks the snapshot incidentsComplete, so an event that drops out of the feed closes as resolved", () => {
    // The currentevents feed is the authoritative active set: AWS removes an
    // event when it resolves rather than marking it, so persist.ts may close a
    // stored-open incident absent from a complete snapshot.
    expect(snapshot.incidentsComplete).toBe(true)
  })
})

describe("awsHealthAdapter.normalize: latest-per-service reduction", () => {
  // impacted_service_status_changes is an append-only log, so a service can
  // degrade and then recover inside one still-open event. Only its latest
  // change describes its current status, so a 0->2->0 history must read as
  // operational (absent), never keep its stale degraded peak. This is the
  // exact global-service case observed live (cloudfront, globalaccelerator).
  const recoveredWithinEvent = [
    {
      date: "1772500000",
      arn: "arn:aws:health:global::event/MULTIPLE_SERVICES/EX/EX_SYNTHETIC",
      region_name: "Global",
      status: "3",
      service: "multipleservices-global",
      summary: "Global service event",
      event_log: [],
      impacted_services: {},
      impacted_service_status_changes: [
        {
          service: "cloudfront",
          previous_status: "0",
          current_status: "2",
          timestamp: 1_772_500_000_000,
        },
        {
          service: "cloudfront",
          previous_status: "2",
          current_status: "0",
          timestamp: 1_772_501_800_000,
        },
        {
          service: "s3-us-east-1",
          previous_status: "0",
          current_status: "3",
          timestamp: 1_772_500_000_000,
        },
      ],
    },
  ]

  const snapshot = awsHealthAdapter.normalize({
    source,
    documents: [currentDoc(recoveredWithinEvent)],
    observedAt: "2026-07-20T12:00:00Z",
  })

  it("omits a service whose latest change returned it to operational, even though an earlier change was degraded", () => {
    expect(snapshot.components.cloudfront).toBeUndefined()
    expect(snapshot.components["s3-us-east-1"]).toMatchObject({
      state: "OUTAGE",
    })
  })

  it("excludes the recovered service from the incident component scope while keeping the still-degraded one", () => {
    const scope = snapshot.incidents[0]!.scope
    expect(scope.kind).toBe("components")
    if (scope.kind !== "components") {
      throw new Error("expected components scope")
    }
    expect(scope.componentIds).not.toContain("cloudfront")
    expect(scope.componentIds).toContain("s3-us-east-1")
  })

  it("keeps the worse of two concurrent events touching one service", () => {
    // One event drives a service to OUTAGE while another has it back operational.
    // worst_of across events still surfaces the OUTAGE.
    const twoEvents = [
      {
        date: "1772500000",
        arn: "arn:aws:health:global::event/A",
        status: "3",
        service: "svc-a",
        event_log: [],
        impacted_services: {},
        impacted_service_status_changes: [
          {
            service: "cloudfront",
            previous_status: "0",
            current_status: "3",
            timestamp: 1_772_500_000_000,
          },
        ],
      },
      {
        date: "1772500000",
        arn: "arn:aws:health:global::event/B",
        status: "1",
        service: "svc-b",
        event_log: [],
        impacted_services: {},
        impacted_service_status_changes: [
          {
            service: "cloudfront",
            previous_status: "2",
            current_status: "0",
            timestamp: 1_772_503_600_000,
          },
        ],
      },
    ]
    const both = awsHealthAdapter.normalize({
      source,
      documents: [currentDoc(twoEvents)],
      observedAt: "2026-07-20T12:00:00Z",
    })
    expect(both.components.cloudfront).toMatchObject({ state: "OUTAGE" })
  })
})

describe("awsHealthAdapter.normalize: live feed shape", () => {
  it("normalizes the sanitized live capture, mapping status 3 services to OUTAGE across both regions", () => {
    const snapshot = awsHealthAdapter.normalize({
      source,
      documents: [currentDoc(live)],
      observedAt: "2026-07-20T12:00:00Z",
    })
    expect(snapshot.incidents).toHaveLength(2)
    expect(snapshot.components["ec2-me-central-1"]).toMatchObject({
      state: "OUTAGE",
    })
    expect(snapshot.components["s3-me-south-1"]).toMatchObject({
      state: "OUTAGE",
    })
    // A us-east-1 install sees no live event for its region, so its service id
    // is absent and resolves OPERATIONAL.
    expect(snapshot.components["ec2-us-east-1"]).toBeUndefined()
  })
})

describe("awsHealthAdapter.normalize: failure handling", () => {
  it("throws AdapterParseError when the document is not the documented top-level array", () => {
    expect(() =>
      awsHealthAdapter.normalize({
        source,
        documents: [currentDoc(malformed)],
        observedAt: "2026-07-20T12:00:00Z",
      })
    ).toThrow(AdapterParseError)
  })

  it("throws AdapterParseError on an unrecognized status code rather than guessing a state", () => {
    expect(() =>
      awsHealthAdapter.normalize({
        source,
        documents: [currentDoc(unknownStatus)],
        observedAt: "2026-07-20T12:00:00Z",
      })
    ).toThrow(AdapterParseError)
  })

  it("throws MISSING_DOCUMENT when the poller did not fetch the currentevents document", () => {
    expect(() =>
      awsHealthAdapter.normalize({
        source,
        documents: [],
        observedAt: "2026-07-20T12:00:00Z",
      })
    ).toThrow(AdapterParseError)
  })
})

// The fetch pipeline these tests drive is the same one the poller uses. AWS
// serves application/json;charset=utf-16 as a big-endian body with an FE FF BOM,
// so these encode exactly that to prove the AWS source's 2 MB per-source cap
// both admits a body larger than the 512 KB default and still aborts an
// oversized one as TOO_LARGE. A TOO_LARGE fetch surfaces as a source failure,
// which reads UNKNOWN in persist, never a partial or false state.

const AWS_FETCH_SOURCE = {
  id: "aws",
  allowedHosts: ["health.aws.amazon.com"],
  maxBodyBytes: 2 * 1024 * 1024,
}
const AWS_URL = "https://health.aws.amazon.com/public/currentevents"

/** Encodes a value as the big-endian UTF-16 JSON body AWS actually serves, FE FF BOM first. */
function utf16beJsonBody(value: unknown): Uint8Array {
  const text = JSON.stringify(value)
  const bytes = new Uint8Array(2 + text.length * 2)
  bytes[0] = 0xfe
  bytes[1] = 0xff
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    bytes[2 + index * 2] = (code >> 8) & 0xff
    bytes[2 + index * 2 + 1] = code & 0xff
  }
  return bytes
}

function bodyOf(bytes: Uint8Array): FetchResponse["body"] {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes
    },
    destroy: vi.fn(),
  }
}

function fakeDispatcher(): ManagedDispatcher {
  return {
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ManagedDispatcher
}

describe("aws_health fetch pipeline and truncation honesty", () => {
  it("decodes a big-endian UTF-16 body over the 512KB default but under the 2MB cap", async () => {
    // A padded but valid event whose UTF-16 body exceeds the 512 KB default,
    // so it would fail without the source's raised 2 MB cap.
    const event = {
      ...((degraded as unknown[])[0] as Record<string, unknown>),
      summary: "x".repeat(400 * 1024),
    }
    const request = vi.fn().mockResolvedValueOnce({
      statusCode: 200,
      headers: { "content-type": "application/json;charset=utf-16" },
      body: bodyOf(utf16beJsonBody([event])),
    })

    const result = await fetchProviderDocument(
      AWS_FETCH_SOURCE,
      { url: AWS_URL },
      { request, createDispatcher: () => fakeDispatcher() }
    )
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      const snapshot = awsHealthAdapter.normalize({
        source,
        documents: [{ kind: "current", url: AWS_URL, json: result.json }],
        observedAt: "2026-07-20T12:00:00Z",
      })
      expect(snapshot.components["s3-us-east-1"]).toMatchObject({
        state: "OUTAGE",
      })
    }
  })

  it("aborts a body larger than the 2MB cap as TOO_LARGE, so the source reads UNKNOWN not a false state", async () => {
    const oversized = new Uint8Array(2 * 1024 * 1024 + 2)
    const request = vi.fn().mockResolvedValueOnce({
      statusCode: 200,
      headers: { "content-type": "application/json;charset=utf-16" },
      body: bodyOf(oversized),
    })
    await expect(
      fetchProviderDocument(
        AWS_FETCH_SOURCE,
        { url: AWS_URL },
        { request, createDispatcher: () => fakeDispatcher() }
      )
    ).rejects.toMatchObject({ code: "TOO_LARGE" })
  })
})
