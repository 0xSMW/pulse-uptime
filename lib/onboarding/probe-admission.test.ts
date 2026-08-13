import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { RateLimitPolicy, RateLimitResult } from "@/lib/api/rate-limit"
import type { LeaseStore } from "@/lib/scheduler/lease"

import {
  OnboardingProbeAdmissionError,
  runWithOnboardingProbeAdmission,
} from "./probe-admission"

type Enforce = (
  principalKey: string,
  policy: RateLimitPolicy
) => Promise<RateLimitResult>

const allowed: RateLimitResult = {
  allowed: true,
  remaining: 9,
  retryAfterSeconds: 60,
}

interface FakeLease {
  ownerId: string
  leaseUntilMs: number
}

function createFakeLeaseStore(nowMs = 0): LeaseStore & {
  advanceTo: (nextNowMs: number) => void
} {
  const leases = new Map<string, FakeLease>()
  let currentNowMs = nowMs
  return {
    advanceTo(nextNowMs) {
      currentNowMs = nextNowMs
    },
    async acquire(name, ownerId, durationMs) {
      const existing = leases.get(name)
      if (existing && existing.leaseUntilMs > currentNowMs) {
        return false
      }
      leases.set(name, {
        ownerId,
        leaseUntilMs: currentNowMs + durationMs,
      })
      return true
    },
    async release(name, ownerId) {
      if (leases.get(name)?.ownerId === ownerId) {
        leases.delete(name)
      }
    },
  }
}

describe("onboarding probe admission", () => {
  it("preserves successful probe results and applies both admission buckets", async () => {
    const enforce = vi.fn<Enforce>(async () => allowed)
    const leases = createFakeLeaseStore()

    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-1",
        target: "HTTPS://Example.COM:443/health?token=secret",
        enforce,
        leases,
        work: async () => ({ success: true }),
      })
    ).resolves.toEqual({ success: true })

    expect(enforce).toHaveBeenCalledTimes(2)
    expect(enforce.mock.calls[0]).toEqual([
      "user:user-1",
      expect.objectContaining({ routeKey: "onboarding-probe-user" }),
    ])
    expect(enforce.mock.calls[1]?.[0]).toBe("resource:onboarding-target")
    expect(enforce.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        routeKey: "onboarding-probe-target",
        resourceKey: expect.any(String),
      })
    )
  })

  it("rejects an exhausted user bucket before target admission or probe work", async () => {
    const enforce = vi.fn(async () => ({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 27,
    }))
    const work = vi.fn(async () => "unreachable")
    const leases = createFakeLeaseStore()

    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-1",
        target: "https://example.com/",
        enforce,
        leases,
        work,
      })
    ).rejects.toMatchObject({
      retryAfterSeconds: 27,
    })
    expect(enforce).toHaveBeenCalledOnce()
    expect(work).not.toHaveBeenCalled()
  })

  it("normalizes target buckets so path and casing cannot evade the limit", async () => {
    const targetKeys: string[] = []
    const leases = createFakeLeaseStore()
    const enforce = vi.fn(
      async (_principal: string, policy: RateLimitPolicy) => {
        if (policy.routeKey === "onboarding-probe-target") {
          targetKeys.push(policy.resourceKey ?? "")
          return targetKeys.length === 1
            ? allowed
            : { allowed: false, remaining: 0, retryAfterSeconds: 18 }
        }
        return allowed
      }
    )

    await runWithOnboardingProbeAdmission({
      userId: "user-1",
      target: "https://EXAMPLE.com:443/one",
      enforce,
      leases,
      work: async () => undefined,
    })
    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-2",
        target: "https://example.com/two?different=true",
        enforce,
        leases,
        work: async () => undefined,
      })
    ).rejects.toBeInstanceOf(OnboardingProbeAdmissionError)

    expect(targetKeys).toHaveLength(2)
    expect(targetKeys[0]).toBe(targetKeys[1])
  })

  it("enforces two shared slots across independent service instances", async () => {
    const enforce = vi.fn(async () => allowed)
    const leases = createFakeLeaseStore()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = vi.fn(async () => {
      await held
      return "done"
    })

    const first = runWithOnboardingProbeAdmission({
      userId: "user-1",
      target: "https://one.example/",
      enforce,
      leases,
      createOwnerId: () => "instance-a-request-1",
      work,
    })
    const second = runWithOnboardingProbeAdmission({
      userId: "user-1",
      target: "https://two.example/",
      enforce,
      leases,
      createOwnerId: () => "instance-b-request-1",
      work,
    })
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2))

    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-1",
        target: "https://three.example/",
        enforce,
        leases,
        createOwnerId: () => "instance-c-request-1",
        work,
      })
    ).rejects.toMatchObject({ retryAfterSeconds: 1 })

    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      "done",
      "done",
    ])
    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-1",
        target: "https://four.example/",
        enforce,
        leases,
        createOwnerId: () => "instance-c-request-2",
        work: async () => "released",
      })
    ).resolves.toBe("released")
  })

  it("recovers abandoned shared slots after the durable lease expires", async () => {
    const enforce = vi.fn(async () => allowed)
    const leases = createFakeLeaseStore(1000)
    let abandonFirst!: () => void
    let abandonSecond!: () => void
    const firstHold = new Promise<void>((resolve) => {
      abandonFirst = resolve
    })
    const secondHold = new Promise<void>((resolve) => {
      abandonSecond = resolve
    })

    const first = runWithOnboardingProbeAdmission({
      userId: "user-1",
      target: "https://one.example/",
      enforce,
      leases,
      createOwnerId: () => "dead-instance-a",
      work: () => firstHold,
    })
    const second = runWithOnboardingProbeAdmission({
      userId: "user-1",
      target: "https://two.example/",
      enforce,
      leases,
      createOwnerId: () => "dead-instance-b",
      work: () => secondHold,
    })
    await vi.waitFor(() => expect(enforce).toHaveBeenCalledTimes(4))

    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-1",
        target: "https://three.example/",
        enforce,
        leases,
        createOwnerId: () => "replacement-instance",
        work: async () => "recovered",
      })
    ).rejects.toBeInstanceOf(OnboardingProbeAdmissionError)

    leases.advanceTo(91_001)
    await expect(
      runWithOnboardingProbeAdmission({
        userId: "user-1",
        target: "https://three.example/",
        enforce,
        leases,
        createOwnerId: () => "replacement-instance",
        work: async () => "recovered",
      })
    ).resolves.toBe("recovered")

    abandonFirst()
    abandonSecond()
    await Promise.all([first, second])
  })
})
