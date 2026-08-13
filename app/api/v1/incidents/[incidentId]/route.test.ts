import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/operational-service", () => ({
  operationalService: { findIncident: vi.fn() },
}))

import { type ApiContext, authorize } from "@/lib/api/middleware"
import { operationalService } from "@/lib/api/operational-service"

import { GET } from "./route"

const INCIDENT_ID = "11111111-1111-4111-8111-111111111111"
const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "tok-1",
    name: "agent",
    scopes: ["incidents:read"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:tok-1",
  requestId: "req_incident",
}

function routeParams(incidentId: string) {
  return { params: Promise.resolve({ incidentId }) }
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(operationalService.findIncident)
    .mockReset()
    .mockResolvedValue({
      id: INCIDENT_ID,
      status: "ongoing",
    } as never)
})

describe("GET /api/v1/incidents/{incidentId}", () => {
  it("returns the existing incident envelope for a valid UUID", async () => {
    const response = await GET(
      new Request(`https://pulse.test/api/v1/incidents/${INCIDENT_ID}`),
      routeParams(INCIDENT_ID)
    )

    expect(response.status).toBe(200)
    expect((await response.json()).kind).toBe("Incident")
    expect(operationalService.findIncident).toHaveBeenCalledWith(INCIDENT_ID)
  })

  it("rejects a malformed UUID before querying storage", async () => {
    const response = await GET(
      new Request("https://pulse.test/api/v1/incidents/not-a-uuid"),
      routeParams("not-a-uuid")
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_INCIDENT")
    expect(operationalService.findIncident).not.toHaveBeenCalled()
  })
})
