import { afterEach, describe, expect, it } from "vitest"

import {
  CRON_RESPONSE_HEADERS,
  isAuthorizedCronRequest,
} from "@/lib/scheduler/authentication"

describe("cron route security", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it("requires an exact bearer secret", () => {
    const secret = "a".repeat(32)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-monitors", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret
      )
    ).toBe(true)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-monitors", {
          headers: { authorization: "Bearer wrong" },
        }),
        secret
      )
    ).toBe(false)
  })

  it("requires the same exact bearer secret for the dependency cron route", () => {
    const secret = "b".repeat(32)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-dependencies", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret
      )
    ).toBe(true)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-dependencies", {
          headers: { authorization: "Bearer wrong" },
        }),
        secret
      )
    ).toBe(false)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-dependencies"),
        secret
      )
    ).toBe(false)
  })

  it("requires the same exact bearer secret for the domain health cron route", () => {
    const secret = "d".repeat(32)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-domains", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret
      )
    ).toBe(true)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-domains", {
          headers: { authorization: "Bearer wrong" },
        }),
        secret
      )
    ).toBe(false)
    expect(
      isAuthorizedCronRequest(
        new Request("https://pulse.test/api/cron/check-domains"),
        secret
      )
    ).toBe(false)
  })

  it("requires the same exact bearer secret for the deploy-proof route", () => {
    const secret = "c".repeat(32)
    expect(
      isAuthorizedCronRequest(
        new Request(
          "https://pulse.test/api/cron/deploy-proof?after=2026-07-20T12:00:00.000Z",
          {
            headers: { authorization: `Bearer ${secret}` },
          }
        ),
        secret
      )
    ).toBe(true)
    expect(
      isAuthorizedCronRequest(
        new Request(
          "https://pulse.test/api/cron/deploy-proof?after=2026-07-20T12:00:00.000Z",
          {
            headers: { authorization: "Bearer wrong" },
          }
        ),
        secret
      )
    ).toBe(false)
  })

  it("sets explicit no-store response headers", () => {
    expect(CRON_RESPONSE_HEADERS["cache-control"]).toContain("no-store")
  })
})
