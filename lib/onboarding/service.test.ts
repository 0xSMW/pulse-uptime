import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/onboarding/probe-admission", () => ({
  runWithOnboardingProbeAdmission: async <T>({
    work,
  }: {
    work: () => Promise<T>
  }) => work(),
}))

import type { CheckResult } from "@/lib/checker"
import {
  createMonitorWithDefaults,
  DEFAULT_MONITOR_SETTINGS,
  hashMonitoringConfig,
  type MonitoringConfig,
} from "@/lib/config"

import {
  activateFirstMonitor,
  completeOnboarding,
  deriveMonitorName,
  isSecurityFailure,
  monitorIdFor,
  OnboardingError,
  type OnboardingMonitorStore,
  type OnboardingMonitorTx,
  saveMonitorDraft,
  validateDraft,
} from "./service"

const ACTOR = {
  userId: "user-1",
  sessionId: "session-1",
  email: "admin@example.com",
  role: "admin" as const,
}

function successCheck(url = "https://example.com/"): CheckResult {
  return {
    mode: "manual",
    method: "GET",
    requestedUrl: url,
    finalUrl: url,
    hostname: "example.com",
    resolvedAddress: "93.184.216.34",
    statusCode: 200,
    latencyMs: 12,
    redirectCount: 0,
    success: true,
    errorCode: null,
    errorMessage: null,
  }
}

function failure(
  errorCode: "BLOCKED_TARGET" | "TIMEOUT" | "INVALID_REDIRECT"
): CheckResult {
  return {
    mode: "manual",
    method: "GET",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    hostname: "example.com",
    resolvedAddress: null,
    statusCode: null,
    latencyMs: 10,
    redirectCount: 0,
    success: false,
    errorCode,
    errorMessage: "failed",
  }
}

interface Progress {
  userId: string
  currentStep: "monitor" | "verify" | "getting_started"
  draftMonitor: {
    url: string
    name: string
    alertEmail?: string
  } | null
  emailWarningAcknowledged: boolean
  completedAt: Date | null
  updatedAt: Date
}

interface FakeWorld {
  sessionActive: boolean
  adminRole: boolean
  activeTransactions: number
  progress: Progress
  accepted: { config: MonitoringConfig; hash: string } | null
  registry: {
    id: string
    enabled: boolean
    configHash: string
    archivedAt: Date | null
  }[]
  adminCompletedAt: Date | null
  snapshots: { hash: string; config: MonitoringConfig }[]
  edgeWrites: MonitoringConfig[]
  lockHeld: boolean
  activationHold: Promise<void> | null
  releaseActivationHold: (() => void) | null
}

function baseConfig(
  version = 1,
  monitors: MonitoringConfig["monitors"] = []
): MonitoringConfig {
  return {
    schemaVersion: 2,
    configVersion: version,
    settings: { ...DEFAULT_MONITOR_SETTINGS },
    groups: [],
    monitors,
  }
}

function createFakeStore(world: FakeWorld): OnboardingMonitorStore {
  const readProgress = async (userId: string) => {
    if (world.progress.userId !== userId) {
      return null
    }
    return {
      userId: world.progress.userId,
      currentStep: world.progress.currentStep,
      draftMonitor: world.progress.draftMonitor,
      emailWarningAcknowledged: world.progress.emailWarningAcknowledged,
      updatedAt: world.progress.updatedAt,
      completedAt: world.progress.completedAt,
    }
  }

  const makeTx = (onConfigurationLock: () => void): OnboardingMonitorTx => ({
    assertActiveAdmin: async (actor) => {
      if (
        !(world.sessionActive && world.adminRole) ||
        actor.userId !== ACTOR.userId ||
        actor.sessionId !== ACTOR.sessionId
      ) {
        throw new OnboardingError(
          "ADMIN_SESSION_REVOKED",
          "Administrator session is no longer active"
        )
      }
    },
    assertActiveSession: async (userId, sessionId) => {
      if (
        !world.sessionActive ||
        userId !== ACTOR.userId ||
        sessionId !== ACTOR.sessionId
      ) {
        throw new OnboardingError(
          "SESSION_REVOKED",
          "The current session is no longer active"
        )
      }
    },
    lockConfiguration: async () => {
      // Simulate exclusive critical section for concurrent callers sharing world.
      while (world.lockHeld) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      world.lockHeld = true
      onConfigurationLock()
    },
    readProgress,
    readAccepted: async () => world.accepted,
    insertAcceptedSnapshot: async ({ config, hash }) => {
      world.snapshots.push({ hash, config })
      world.accepted = { config, hash }
    },
    synchronizeRegistry: async (config, hash) => {
      const desired = new Set(config.monitors.map((monitor) => monitor.id))
      for (const row of world.registry) {
        if (!desired.has(row.id)) {
          row.enabled = false
          row.archivedAt = new Date()
        }
      }
      for (const monitor of config.monitors) {
        const existing = world.registry.find((row) => row.id === monitor.id)
        if (existing) {
          existing.enabled = monitor.enabled
          existing.configHash = hash
          existing.archivedAt = null
        } else {
          world.registry.push({
            id: monitor.id,
            enabled: monitor.enabled,
            configHash: hash,
            archivedAt: null,
          })
        }
      }
    },
    advanceToGettingStarted: async (userId) => {
      if (world.activationHold) {
        await world.activationHold
      }
      if (
        world.progress.userId !== userId ||
        world.progress.completedAt ||
        world.progress.currentStep !== "verify"
      ) {
        return false
      }
      world.progress.currentStep = "getting_started"
      world.progress.updatedAt = new Date()
      return true
    },
    countEnabledRegistryForHash: async (hash) =>
      world.registry.filter(
        (row) =>
          row.enabled && row.configHash === hash && row.archivedAt === null
      ).length,
    completeProgress: async (userId, now) => {
      if (
        world.progress.userId !== userId ||
        world.progress.completedAt ||
        world.progress.currentStep !== "getting_started"
      ) {
        return false
      }
      world.progress.completedAt = now
      world.progress.updatedAt = now
      return true
    },
    completeAdmin: async (userId, now) => {
      if (world.progress.userId !== userId || world.adminCompletedAt) {
        return false
      }
      world.adminCompletedAt = now
      return true
    },
  })

  return {
    updateDraft: async (userId, draft) => {
      if (
        world.progress.userId !== userId ||
        world.progress.completedAt ||
        !["monitor", "verify"].includes(world.progress.currentStep)
      ) {
        return "conflict"
      }
      world.progress.draftMonitor = draft
      world.progress.currentStep = "verify"
      world.progress.updatedAt = new Date()
      return "ok"
    },
    moveBack: async (userId, step) => {
      if (
        world.progress.userId !== userId ||
        world.progress.completedAt ||
        !["monitor", "verify"].includes(world.progress.currentStep)
      ) {
        return "conflict"
      }
      world.progress.currentStep = step
      return "ok"
    },
    readProgress,
    transaction: async (work) => {
      let ownsConfigurationLock = false
      world.activeTransactions += 1
      try {
        return await work(
          makeTx(() => {
            ownsConfigurationLock = true
          })
        )
      } finally {
        world.activeTransactions -= 1
        if (ownsConfigurationLock) {
          world.lockHeld = false
        }
      }
    },
  }
}

function freshWorld(overrides: Partial<Progress> = {}): FakeWorld {
  return {
    sessionActive: true,
    adminRole: true,
    activeTransactions: 0,
    progress: {
      userId: "user-1",
      currentStep: "monitor",
      draftMonitor: null,
      emailWarningAcknowledged: false,
      completedAt: null,
      updatedAt: new Date("2026-07-18T00:00:00Z"),
      ...overrides,
    },
    accepted: null,
    registry: [],
    adminCompletedAt: null,
    snapshots: [],
    edgeWrites: [],
    lockHeld: false,
    activationHold: null,
    releaseActivationHold: null,
  }
}

describe("onboarding monitor helpers", () => {
  it("derives editable names and stable valid slugs", () => {
    expect(deriveMonitorName("https://www.example.com/health")).toBe(
      "example.com"
    )
    expect(monitorIdFor("My Main Site", "https://example.com")).toBe(
      "my-main-site"
    )
  })

  it("normalizes and preserves a public monitor draft", () => {
    expect(
      validateDraft({ url: "https://example.com", name: " Main Site " })
    ).toEqual({
      url: "https://example.com/",
      name: "Main Site",
      alertEmail: undefined,
    })
  })

  it("blocks security failures while allowing availability overrides", () => {
    expect(isSecurityFailure(failure("BLOCKED_TARGET"))).toBe(true)
    expect(isSecurityFailure(failure("INVALID_REDIRECT"))).toBe(true)
    expect(isSecurityFailure(failure("TIMEOUT"))).toBe(false)
  })
})

describe("onboarding state machine", () => {
  it("saveMonitorDraft transitions incomplete monitor → verify", async () => {
    const world = freshWorld({ currentStep: "monitor" })
    const store = createFakeStore(world)
    const draft = await saveMonitorDraft(
      "user-1",
      { url: "https://example.com", name: "Main" },
      { store }
    )
    expect(draft.url).toBe("https://example.com/")
    expect(world.progress.currentStep).toBe("verify")
    expect(world.progress.draftMonitor).toMatchObject({ name: "Main" })
  })

  it("rejects draft save after activation", async () => {
    const world = freshWorld({
      currentStep: "getting_started",
      draftMonitor: {
        url: "https://example.com/",
        name: "Main",
      },
    })
    await expect(
      saveMonitorDraft(
        "user-1",
        { url: "https://other.example", name: "Other" },
        { store: createFakeStore(world) }
      )
    ).rejects.toMatchObject({ code: "ONBOARDING_STATE_CONFLICT" })
    expect(world.progress.currentStep).toBe("getting_started")
  })

  it("normal flow: monitor → verify → getting_started → dashboard", async () => {
    const world = freshWorld({ currentStep: "monitor" })
    const store = createFakeStore(world)
    const edgeWrites: MonitoringConfig[] = []

    await saveMonitorDraft(
      "user-1",
      { url: "https://example.com", name: "Main Site" },
      { store }
    )
    expect(world.progress.currentStep).toBe("verify")

    const activated = await activateFirstMonitor(
      ACTOR,
      { alertEmail: "admin@example.com" },
      {
        store,
        checkReadiness: async () => ({ canContinue: true }),
        runCheck: async () => successCheck(),
        writeEdgeConfig: async (config) => {
          edgeWrites.push(config)
        },
      }
    )
    expect(world.progress.currentStep).toBe("getting_started")
    expect(activated.monitor.name).toBe("Main Site")
    expect(world.accepted?.hash).toBe(activated.hash)
    expect(world.registry).toEqual([
      expect.objectContaining({
        id: activated.monitor.id,
        enabled: true,
        configHash: activated.hash,
        archivedAt: null,
      }),
    ])
    expect(edgeWrites).toHaveLength(1)
    expect(edgeWrites[0]!.configVersion).toBe(1)

    await completeOnboarding(ACTOR, { store })
    expect(world.progress.completedAt).toBeInstanceOf(Date)
    expect(world.adminCompletedAt).toBeInstanceOf(Date)
  })

  it("runs database-backed readiness outside the authority transaction and the site probe inside it", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    await activateFirstMonitor(
      ACTOR,
      {},
      {
        store: createFakeStore(world),
        checkReadiness: async () => {
          expect(world.activeTransactions).toBe(0)
          return { canContinue: true }
        },
        runCheck: async () => {
          expect(world.activeTransactions).toBe(1)
          return successCheck()
        },
        writeEdgeConfig: async () => undefined,
      }
    )
    expect(world.activeTransactions).toBe(0)
  })

  it.each(["revoked", "demoted"] as const)(
    "rejects activation when the admitted admin session is %s after the probe",
    async (change) => {
      const world = freshWorld({
        currentStep: "verify",
        draftMonitor: { url: "https://example.com/", name: "Main" },
      })
      const store = createFakeStore(world)
      const originalTransaction = store.transaction.bind(store)
      let transactionCount = 0
      store.transaction = async (work) => {
        const result = await originalTransaction(work)
        transactionCount += 1
        if (transactionCount === 1) {
          if (change === "revoked") {
            world.sessionActive = false
          } else {
            world.adminRole = false
          }
        }
        return result
      }
      const writeEdgeConfig = vi.fn(async () => undefined)

      await expect(
        activateFirstMonitor(
          ACTOR,
          {},
          {
            store,
            checkReadiness: async () => ({ canContinue: true }),
            runCheck: async () => successCheck(),
            writeEdgeConfig,
          }
        )
      ).rejects.toMatchObject({ code: "ADMIN_SESSION_REVOKED" })

      expect(world.progress.currentStep).toBe("verify")
      expect(world.snapshots).toEqual([])
      expect(world.registry).toEqual([])
      expect(world.accepted).toBeNull()
      expect(writeEdgeConfig).not.toHaveBeenCalled()
    }
  )

  it("does not run the site probe after the admitted admin session is revoked", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    const originalTransaction = store.transaction.bind(store)
    store.transaction = async (work) => {
      world.sessionActive = false
      return originalTransaction(work)
    }
    const checkReadiness = vi.fn(async () => ({ canContinue: true }))
    const runCheck = vi.fn(async () => successCheck())
    const writeEdgeConfig = vi.fn(async () => undefined)

    await expect(
      activateFirstMonitor(
        ACTOR,
        {},
        {
          store,
          checkReadiness,
          runCheck,
          writeEdgeConfig,
        }
      )
    ).rejects.toMatchObject({ code: "ADMIN_SESSION_REVOKED" })

    expect(checkReadiness).toHaveBeenCalledOnce()
    expect(runCheck).not.toHaveBeenCalled()
    expect(writeEdgeConfig).not.toHaveBeenCalled()
    expect(world.progress.currentStep).toBe("verify")
  })

  it("does not probe a draft changed after admission", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    const originalTransaction = store.transaction.bind(store)
    store.transaction = async (work) => {
      world.progress.draftMonitor = {
        url: "https://other.example/",
        name: "Other",
      }
      return originalTransaction(work)
    }
    const runCheck = vi.fn(async () => successCheck())

    await expect(
      activateFirstMonitor(
        ACTOR,
        {},
        {
          store,
          checkReadiness: async () => ({ canContinue: true }),
          runCheck,
        }
      )
    ).rejects.toMatchObject({ code: "ONBOARDING_STATE_CONFLICT" })
    expect(runCheck).not.toHaveBeenCalled()
    expect(world.progress.currentStep).toBe("verify")
    expect(world.accepted).toBeNull()
  })

  it("rejects direct completion before activation (both rows stay incomplete)", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)

    await expect(completeOnboarding(ACTOR, { store })).rejects.toMatchObject({
      code: "ONBOARDING_STATE_CONFLICT",
    })
    expect(world.progress.completedAt).toBeNull()
    expect(world.adminCompletedAt).toBeNull()
    expect(world.progress.currentStep).toBe("verify")
  })

  it("rejects completion if the admitted human session is revoked before its transaction", async () => {
    const world = freshWorld({
      currentStep: "getting_started",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const config = baseConfig(1, [
      createMonitorWithDefaults({
        id: "main",
        name: "Main",
        url: "https://example.com/",
      }),
    ])
    const hash = hashMonitoringConfig(config)
    world.accepted = { config, hash }
    world.registry = [
      { id: "main", enabled: true, configHash: hash, archivedAt: null },
    ]
    const store = createFakeStore(world)
    const originalTransaction = store.transaction.bind(store)
    store.transaction = async (work) => {
      world.sessionActive = false
      return originalTransaction(work)
    }

    await expect(completeOnboarding(ACTOR, { store })).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    })
    expect(world.progress.completedAt).toBeNull()
    expect(world.adminCompletedAt).toBeNull()
    expect(world.progress.currentStep).toBe("getting_started")
  })

  it("rejects duplicate activation after step advanced", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    const deps = {
      store,
      checkReadiness: async () => ({ canContinue: true }),
      runCheck: async () => successCheck(),
      writeEdgeConfig: async () => undefined,
    }

    await activateFirstMonitor(ACTOR, { alertEmail: "a@example.com" }, deps)
    await expect(
      activateFirstMonitor(ACTOR, { alertEmail: "stale@example.com" }, deps)
    ).rejects.toMatchObject({ code: "ONBOARDING_STATE_CONFLICT" })

    expect(world.progress.currentStep).toBe("getting_started")
    const accepted = world.accepted!
    const monitor = accepted.config.monitors[0]!
    expect(monitor.recipients).toEqual(["a@example.com"])
    expect(monitor.recipients).not.toContain("stale@example.com")
  })

  it("rolls activation back when Edge Config fails so retry can succeed", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    const transaction = store.transaction.bind(store)
    store.transaction = async (work) => {
      const progress = structuredClone(world.progress)
      const accepted = structuredClone(world.accepted)
      const registry = structuredClone(world.registry)
      const snapshots = structuredClone(world.snapshots)
      try {
        return await transaction(work)
      } catch (error) {
        Object.assign(world.progress, progress)
        world.accepted = accepted
        world.registry.splice(0, world.registry.length, ...registry)
        world.snapshots.splice(0, world.snapshots.length, ...snapshots)
        throw error
      }
    }
    const writeEdgeConfig = vi
      .fn<(config: MonitoringConfig) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Edge Config unavailable"))
      .mockResolvedValueOnce()
    const deps = {
      store,
      checkReadiness: async () => ({ canContinue: true }),
      runCheck: async () => successCheck(),
      writeEdgeConfig,
    }

    await expect(
      activateFirstMonitor(ACTOR, { alertEmail: "a@example.com" }, deps)
    ).rejects.toThrow("Edge Config unavailable")

    expect(world.progress.currentStep).toBe("verify")
    expect(world.accepted).toBeNull()
    expect(world.registry).toEqual([])
    expect(world.snapshots).toEqual([])

    const activated = await activateFirstMonitor(
      ACTOR,
      { alertEmail: "a@example.com" },
      deps
    )

    expect(activated.monitor.name).toBe("Main")
    expect(world.progress.currentStep).toBe("getting_started")
    expect(world.accepted?.hash).toBe(activated.hash)
    expect(writeEdgeConfig).toHaveBeenCalledTimes(2)
  })

  it("serializes concurrent stale activation so only one winner advances", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    let releaseFirst!: () => void
    world.activationHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const deps = {
      store,
      checkReadiness: async () => ({ canContinue: true }),
      runCheck: async () => successCheck(),
      writeEdgeConfig: async () => undefined,
    }

    const first = activateFirstMonitor(
      ACTOR,
      { alertEmail: "winner@example.com" },
      deps
    )
    // Let the first transaction acquire the lock and reach the hold.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const second = activateFirstMonitor(
      ACTOR,
      { alertEmail: "loser@example.com" },
      deps
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    releaseFirst()
    const results = await Promise.allSettled([first, second])
    const fulfilled = results.filter((item) => item.status === "fulfilled")
    const rejected = results.filter((item) => item.status === "rejected")

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ONBOARDING_STATE_CONFLICT",
    })
    expect(world.progress.currentStep).toBe("getting_started")
    expect(world.accepted!.config.monitors[0]!.recipients).toEqual([
      "winner@example.com",
    ])
    expect(world.snapshots).toHaveLength(1)
  })

  it("keeps accepted snapshot hash and registry hash agreed after activation", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    const result = await activateFirstMonitor(
      ACTOR,
      { alertEmail: "admin@example.com" },
      {
        store,
        checkReadiness: async () => ({ canContinue: true }),
        runCheck: async () => successCheck(),
        writeEdgeConfig: async () => undefined,
      }
    )

    expect(world.accepted?.hash).toBe(result.hash)
    expect(world.registry.every((row) => row.configHash === result.hash)).toBe(
      true
    )
    expect(
      world.registry.some(
        (row) => row.enabled && row.configHash === result.hash
      )
    ).toBe(true)
  })

  it("derives initial version and hash from accepted state under lock", async () => {
    const existingMonitor = createMonitorWithDefaults({
      id: "seeded-monitor",
      name: "Seeded",
      url: "https://seeded.example/",
    })
    const existing = baseConfig(4, [existingMonitor])
    const existingHash = hashMonitoringConfig(existing)
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    world.accepted = { config: existing, hash: existingHash }
    world.registry = [
      {
        id: "seeded-monitor",
        enabled: true,
        configHash: existingHash,
        archivedAt: null,
      },
    ]

    const store = createFakeStore(world)
    const result = await activateFirstMonitor(
      ACTOR,
      { alertEmail: "admin@example.com" },
      {
        store,
        checkReadiness: async () => ({ canContinue: true }),
        runCheck: async () => successCheck(),
        writeEdgeConfig: async () => undefined,
      }
    )

    expect(result.config.configVersion).toBe(5)
    expect(result.config.configVersion).not.toBe(1)
    expect(world.accepted!.config.configVersion).toBe(5)
    expect(world.accepted!.config.monitors.map((m) => m.id).sort()).toEqual([
      "main",
      "seeded-monitor",
    ])
  })

  it("completion requires getting_started, accepted snapshot, and enabled registry row", async () => {
    const world = freshWorld({
      currentStep: "getting_started",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)

    // No accepted snapshot yet.
    await expect(completeOnboarding(ACTOR, { store })).rejects.toMatchObject({
      code: "ONBOARDING_STATE_CONFLICT",
    })
    expect(world.progress.completedAt).toBeNull()
    expect(world.adminCompletedAt).toBeNull()

    const config = baseConfig(1, [
      createMonitorWithDefaults({
        id: "main",
        name: "Main",
        url: "https://example.com/",
      }),
    ])
    const hash = hashMonitoringConfig(config)
    world.accepted = { config, hash }
    // Registry row missing / wrong hash.
    world.registry = [
      {
        id: "main",
        enabled: true,
        configHash: "sha256:other",
        archivedAt: null,
      },
    ]
    await expect(completeOnboarding(ACTOR, { store })).rejects.toMatchObject({
      code: "ONBOARDING_STATE_CONFLICT",
    })
    expect(world.progress.completedAt).toBeNull()
    expect(world.adminCompletedAt).toBeNull()

    world.registry[0]!.configHash = hash
    await completeOnboarding(ACTOR, { store })
    expect(world.progress.completedAt).toBeInstanceOf(Date)
    expect(world.adminCompletedAt).toBeInstanceOf(Date)
  })

  it("rejects activation when readiness fails or step is wrong", async () => {
    const world = freshWorld({
      currentStep: "monitor",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)

    await expect(
      activateFirstMonitor(
        ACTOR,
        {},
        {
          store,
          checkReadiness: async () => ({ canContinue: false }),
          runCheck: async () => successCheck(),
        }
      )
    ).rejects.toMatchObject({ code: "NOT_READY" })

    await expect(
      activateFirstMonitor(
        ACTOR,
        {},
        {
          store,
          checkReadiness: async () => ({ canContinue: true }),
          runCheck: async () => successCheck(),
          writeEdgeConfig: async () => undefined,
        }
      )
    ).rejects.toMatchObject({ code: "ONBOARDING_STATE_CONFLICT" })
  })

  it("surfaces OnboardingError for blocked checks", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    await expect(
      activateFirstMonitor(
        ACTOR,
        {},
        {
          store: createFakeStore(world),
          checkReadiness: async () => ({ canContinue: true }),
          runCheck: async () => failure("BLOCKED_TARGET"),
        }
      )
    ).rejects.toBeInstanceOf(OnboardingError)
    expect(world.progress.currentStep).toBe("verify")
    expect(world.accepted).toBeNull()
  })

  it("uses the shared configuration lock key path during activation", async () => {
    const world = freshWorld({
      currentStep: "verify",
      draftMonitor: { url: "https://example.com/", name: "Main" },
    })
    const store = createFakeStore(world)
    const lockSpy = vi.fn(async () => {
      world.lockHeld = true
    })
    const originalTransaction = store.transaction.bind(store)
    store.transaction = async (work) =>
      originalTransaction(async (tx) => {
        tx.lockConfiguration = lockSpy
        return work(tx)
      })

    await activateFirstMonitor(
      ACTOR,
      { alertEmail: "admin@example.com" },
      {
        store,
        checkReadiness: async () => ({ canContinue: true }),
        runCheck: async () => successCheck(),
        writeEdgeConfig: async () => undefined,
      }
    )
    expect(lockSpy).toHaveBeenCalledOnce()
  })
})
