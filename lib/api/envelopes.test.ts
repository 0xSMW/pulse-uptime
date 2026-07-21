import { describe, expect, it } from "vitest"

import {
  errorEnvelope,
  listEnvelope,
  objectEnvelope,
  requestIdFrom,
} from "./envelopes"

describe("API envelopes", () => {
  it("builds stable object and list envelopes", () => {
    expect(objectEnvelope("Monitor", { id: "mon_1" }, "req_1")).toEqual({
      apiVersion: "v1",
      kind: "Monitor",
      data: { id: "mon_1" },
      meta: { requestId: "req_1" },
    })
    expect(listEnvelope("MonitorList", [], "req_2", null)).toEqual({
      apiVersion: "v1",
      kind: "MonitorList",
      data: [],
      meta: { requestId: "req_2", nextCursor: null },
    })
  })

  it("keeps the request ID in the documented error location", () => {
    expect(errorEnvelope("NOT_FOUND", "Missing", "req_3")).toEqual({
      apiVersion: "v1",
      kind: "Error",
      error: {
        code: "NOT_FOUND",
        message: "Missing",
        details: {},
        requestId: "req_3",
      },
    })
  })

  it("accepts safe caller IDs and replaces malformed IDs", () => {
    expect(
      requestIdFrom(
        new Request("https://pulse.test", {
          headers: { "X-Request-ID": "2cecd18e-e7c0-4e9c-814d-bf43ecb6144f" },
        })
      )
    ).toBe("2cecd18e-e7c0-4e9c-814d-bf43ecb6144f")
    expect(
      requestIdFrom(
        new Request("https://pulse.test", {
          headers: { "X-Request-ID": "bad id\n" },
        })
      )
    ).toMatch(/^req_[0-9a-f-]{36}$/)
  })
})
