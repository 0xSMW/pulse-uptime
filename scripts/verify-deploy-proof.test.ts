import { afterEach, describe, expect, it, vi } from "vitest"

import { main, verifyDeployProof } from "./verify-deploy-proof.mjs"

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("verifyDeployProof", () => {
  it("passes when ready with matching release id and completedAt after boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: "ready",
        releaseId: "dpl_expected",
        runId: "run-1",
        scheduledMinute: "2026-07-20T12:01:00.000Z",
        startedAt: "2026-07-20T12:01:01.000Z",
        completedAt: "2026-07-20T12:01:10.000Z",
      })
    )

    const result = await verifyDeployProof({
      baseUrl: "https://pulse.example.com",
      cronSecret: "c".repeat(32),
      after: "2026-07-20T12:00:00.000Z",
      expectedReleaseId: "dpl_expected",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    })

    expect(result).toEqual({
      ok: true,
      releaseId: "dpl_expected",
      runId: "run-1",
      completedAt: "2026-07-20T12:01:10.000Z",
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/api/cron/deploy-proof?after=2026-07-20T12%3A00%3A00.000Z"
    )
  })

  it("fails the canary when the response release id mismatches expected", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: "ready",
        releaseId: "dpl_other",
        runId: "run-1",
        completedAt: "2026-07-20T12:01:10.000Z",
      })
    )

    const result = await verifyDeployProof({
      baseUrl: "https://pulse.example.com",
      cronSecret: "c".repeat(32),
      after: "2026-07-20T12:00:00.000Z",
      expectedReleaseId: "dpl_expected",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
      sleep: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/release id mismatch/)
    }
  })

  it("retries while waiting then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          status: "waiting",
          releaseId: "dpl_expected",
          latest: { runId: "run-r", status: "running", completedAt: null },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "ready",
          releaseId: "dpl_expected",
          runId: "run-2",
          completedAt: "2026-07-20T12:02:00.000Z",
        })
      )

    const result = await verifyDeployProof({
      baseUrl: "https://pulse.example.com/",
      cronSecret: "c".repeat(32),
      after: "2026-07-20T12:00:00.000Z",
      expectedReleaseId: "dpl_expected",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 5,
      sleepSeconds: 0,
      sleep: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    })

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("fails immediately on misconfigured production identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(500, {
        status: "misconfigured",
        error: "PULSE_RELEASE_ID is missing",
      })
    )

    const result = await verifyDeployProof({
      baseUrl: "https://pulse.example.com",
      cronSecret: "c".repeat(32),
      after: "2026-07-20T12:00:00.000Z",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 3,
      sleep: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/misconfigured/)
    }
  })

  it("fails when ready completedAt is before the promotion boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: "ready",
        releaseId: "dpl_expected",
        runId: "run-1",
        completedAt: "2026-07-20T11:00:00.000Z",
      })
    )

    const result = await verifyDeployProof({
      baseUrl: "https://pulse.example.com",
      cronSecret: "c".repeat(32),
      after: "2026-07-20T12:00:00.000Z",
      expectedReleaseId: "dpl_expected",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
      sleep: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/before promotion boundary/)
    }
  })
})

describe("verify-deploy-proof main", () => {
  it("exits non-zero when verification fails", async () => {
    const exit = vi.fn()
    const verify = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "release id mismatch" })
    const code = await main(
      {
        BASE_URL: "https://pulse.example.com",
        CRON_SECRET: "c".repeat(32),
        AFTER: "2026-07-20T12:00:00.000Z",
        EXPECTED_RELEASE_ID: "dpl_expected",
      },
      { verify, exit }
    )
    expect(code).toBe(1)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
