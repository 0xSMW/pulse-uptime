import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  deliverPendingNotifications,
  NotificationDeliveryInfrastructureError,
  retryAt,
} from "./delivery"
import { createNotificationMessage, incidentUrl } from "./message"
import { NotificationProviderError, type NotificationSender } from "./provider"
import { reconcileStaleClaims, type SqlExecutor } from "./sql"
import type { ClaimedNotification, DeliveryLogEntry } from "./types"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function claimRowsQueryResult(rows: ClaimedNotification[]) {
  return rows.map((row) => ({
    id: row.id,
    incident_id: row.incidentId,
    monitor_id: row.monitorId,
    dependency_id: row.dependencyId,
    event_type: row.eventType,
    recipient: row.recipient,
    idempotency_key: row.idempotencyKey,
    payload: row.payload,
    attempt_count: row.attemptCount,
    claim_token: row.claimToken,
  }))
}

function claimed(
  overrides: Partial<ClaimedNotification> = {}
): ClaimedNotification {
  return {
    id: "notification-1",
    incidentId: "incident-1",
    monitorId: "api",
    dependencyId: null,
    eventType: "incident.opened",
    recipient: "ops@example.com",
    idempotencyKey: "incident/incident-1/opened/hash",
    payload: {
      type: "incident.opened",
      monitorName: "Public API",
      incidentId: "incident-1",
      startedAt: "Jul 18 at 07:00 UTC",
      cause: "Connection timed out",
    },
    attemptCount: 1,
    claimToken: "claim-1",
    ...overrides,
  }
}

function dbReturning(
  rows: ClaimedNotification[],
  finalize = true
): SqlExecutor {
  return {
    async query<T>(text: string): Promise<readonly T[]> {
      if (text.includes("with due as")) {
        return claimRowsQueryResult(rows) as T[]
      }
      return (finalize ? [{ id: "updated" }] : []) as T[]
    },
  }
}

describe("notification messages", () => {
  it("links outage email to the canonical incident route", () => {
    expect(
      incidentUrl("https://pulse.example.com/base?old=1", "incident/1")
    ).toBe("https://pulse.example.com/incidents/incident%2F1")
    const message = createNotificationMessage(
      claimed(),
      "https://pulse.example.com"
    )
    const html = renderToStaticMarkup(message.react)
    expect(message.subject).toBe("Public API is down")
    expect(html).toContain("https://pulse.example.com/incidents/incident-1")
    expect(html).toContain("Connection timed out")
  })

  it("builds concise recovery and test messages", () => {
    const recovery = createNotificationMessage(
      claimed({
        eventType: "incident.resolved",
        payload: {
          type: "incident.resolved",
          monitorName: "Public API",
          incidentId: "incident-1",
          recoveredAt: "Jul 18 at 07:08 UTC",
          duration: "8 minutes",
        },
      }),
      "https://pulse.example.com"
    )
    expect(recovery.subject).toBe("Public API recovered")
    expect(renderToStaticMarkup(recovery.react)).toContain("8 minutes")

    const test = createNotificationMessage(
      claimed({
        eventType: "notification.test",
        incidentId: null,
        payload: { type: "notification.test", installationName: "Production" },
      }),
      "https://pulse.example.com"
    )
    expect(test.subject).toBe("Pulse notification test")
    expect(renderToStaticMarkup(test.react)).toContain("Production can deliver")
  })

  it("renders a dependency incident notification with neutral provider-reported wording", () => {
    const message = createNotificationMessage(
      claimed({
        eventType: "dependency.incident",
        incidentId: null,
        monitorId: null,
        dependencyId: "dep-1",
        payload: {
          type: "dependency.incident",
          dependencyName: "Vercel Runtime",
          provider: "Vercel",
          incidentTitle: "Elevated function errors",
          state: "OUTAGE",
          canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
          providerTimestamp: "Jul 19 at 12:00 UTC",
        },
      }),
      "https://pulse.example.com"
    )
    expect(message.subject).toBe("Vercel Runtime: provider reported incident")
    const html = renderToStaticMarkup(message.react)
    expect(html).toContain("Vercel reports Elevated function errors")
    expect(html).toContain("https://www.vercel-status.com/incidents/inc-1")
    // No latestUpdate in the payload: the generic note is the fallback.
    expect(html).toContain("not an independent Pulse check")
  })

  it("quotes the incident's latest provider update with its timestamp in place of the generic note", () => {
    const message = createNotificationMessage(
      claimed({
        eventType: "dependency.incident",
        incidentId: null,
        monitorId: null,
        dependencyId: "dep-1",
        payload: {
          type: "dependency.incident",
          dependencyName: "Vercel Runtime",
          provider: "Vercel",
          incidentTitle: "Elevated function errors",
          state: "OUTAGE",
          canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
          providerTimestamp: "Jul 19 at 12:00 UTC",
          latestUpdate: {
            body: "We are currently investigating elevated function errors.",
            timestamp: "Jul 19 at 12:05 UTC",
          },
        },
      }),
      "https://pulse.example.com"
    )
    const html = renderToStaticMarkup(message.react)
    expect(html).toContain(
      "We are currently investigating elevated function errors."
    )
    expect(html).toContain("Update posted Jul 19 at 12:05 UTC")
    expect(html).not.toContain("not an independent Pulse check")
  })

  it("renders a dependency recovery notification", () => {
    const message = createNotificationMessage(
      claimed({
        eventType: "dependency.recovery",
        incidentId: null,
        monitorId: null,
        dependencyId: "dep-1",
        payload: {
          type: "dependency.recovery",
          dependencyName: "Vercel Runtime",
          provider: "Vercel",
          incidentTitle: "Elevated function errors",
          state: "OPERATIONAL",
          canonicalUrl: null,
          providerTimestamp: "Jul 19 at 12:30 UTC",
          latestUpdate: {
            body: "This incident has been resolved.",
            timestamp: "Jul 19 at 12:28 UTC",
          },
        },
      }),
      "https://pulse.example.com"
    )
    expect(message.subject).toBe("Vercel Runtime: provider incident resolved")
    const html = renderToStaticMarkup(message.react)
    expect(html).toContain("Elevated function errors resolved")
    expect(html).toContain("This incident has been resolved.")
    expect(html).toContain("Update posted Jul 19 at 12:28 UTC")
    expect(html).not.toContain("not an independent Pulse check")
  })

  it("renders a domain expiry notification without a monitor or dependency", () => {
    const message = createNotificationMessage(
      claimed({
        eventType: "domain.expiry",
        incidentId: null,
        monitorId: null,
        dependencyId: null,
        payload: {
          type: "domain.expiry",
          apexDomain: "example.com",
          expiresAt: "2026-08-09T12:00:00.000Z",
          thresholdDays: 14,
          autoRenew: true,
        },
      }),
      "https://pulse.example.com"
    )

    expect(message.subject).toBe("example.com expires in 14 days")
    const html = renderToStaticMarkup(message.react)
    expect(html).toContain("Domain example.com")
    expect(html).toContain("Expires 2026-08-09T12:00:00.000Z")
    expect(html).toContain("Alert threshold 14 days")
    expect(html).toContain("Auto-renew enabled")
    expect(html).toContain("Manage domain at Porkbun")
    expect(html).toContain("https://porkbun.com/account/domainsSpeedy")
  })

  it("rejects a payload whose type does not match its event", () => {
    expect(() =>
      createNotificationMessage(
        claimed({
          eventType: "dependency.incident",
          incidentId: null,
          payload: {
            type: "dependency.recovery",
            dependencyName: "Vercel Runtime",
            provider: "Vercel",
            incidentTitle: "x",
            state: "OPERATIONAL",
            canonicalUrl: null,
            providerTimestamp: "now",
          },
        }),
        "https://pulse.example.com"
      )
    ).toThrow(/does not match/)
  })
})

describe("outbox delivery", () => {
  const now = new Date("2026-07-18T00:00:00Z")

  it("passes the permanent key to the sender and records a safe sent event", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "email-1" }))
    const logs: DeliveryLogEntry[] = []
    const result = await deliverPendingNotifications({
      db: dbReturning([claimed()]),
      sender: { send },
      appUrl: "https://pulse.example.com",
      now: () => now,
      createClaimToken: () => "claim-1",
      log: (entry) => logs.push(entry),
    })
    expect(result).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      dead: 0,
      lostClaims: 0,
    })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ops@example.com" }),
      "incident/incident-1/opened/hash",
      expect.any(AbortSignal)
    )
    expect(logs).toEqual([
      expect.objectContaining({
        event: "notification.sent",
        notificationId: "notification-1",
      }),
    ])
    expect(JSON.stringify(logs)).not.toContain("ops@example.com")
  })

  it("retries transient failures with backoff and never logs provider messages", async () => {
    const logs: DeliveryLogEntry[] = []
    const sender: NotificationSender = {
      async send() {
        throw new NotificationProviderError("rate_limit_exceeded", {
          retryable: true,
        })
      },
    }
    const result = await deliverPendingNotifications({
      db: dbReturning([claimed()]),
      sender,
      appUrl: "https://pulse.example.com",
      now: () => now,
      log: (entry) => logs.push(entry),
    })
    expect(result.failed).toBe(1)
    expect(result.dead).toBe(0)
    expect(logs[0]).toMatchObject({ errorCode: "rate_limit_exceeded" })
    expect(retryAt(now, 1)).toEqual(new Date("2026-07-18T00:01:00Z"))
    expect(retryAt(now, 4)).toEqual(new Date("2026-07-18T02:00:00Z"))
  })

  it("aborts a stalled send and schedules it for retry", async () => {
    vi.useFakeTimers()
    try {
      const updates: Array<readonly unknown[]> = []
      const db: SqlExecutor = {
        async query<T>(
          text: string,
          values: readonly unknown[] = []
        ): Promise<readonly T[]> {
          if (text.includes("with due as")) {
            return claimRowsQueryResult([claimed()]) as T[]
          }
          updates.push(values)
          return [{ id: "updated" }] as T[]
        },
      }
      let observedSignal: AbortSignal | undefined
      const sender: NotificationSender = {
        send(_message, _idempotencyKey, signal) {
          observedSignal = signal
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          })
        },
      }

      const delivery = deliverPendingNotifications(
        {
          db,
          sender,
          appUrl: "https://pulse.example.com",
          now: () => now,
        },
        { perSendTimeoutMs: 100 }
      )
      await vi.advanceTimersByTimeAsync(100)

      await expect(delivery).resolves.toEqual({
        claimed: 1,
        sent: 0,
        failed: 1,
        dead: 0,
        lostClaims: 0,
      })
      expect(observedSignal?.aborted).toBe(true)
      expect(updates).toContainEqual([
        "notification-1",
        "claim-1",
        "failed",
        new Date("2026-07-18T00:01:00Z"),
        "delivery_timeout",
        now,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops a large drain at its deadline and releases queued claims in one update", async () => {
    vi.useFakeTimers()
    try {
      const rows = Array.from({ length: 100 }, (_, index) =>
        claimed({ id: `notification-${index + 1}` })
      )
      const queries: string[] = []
      let releasedIds: readonly string[] = []
      const db: SqlExecutor = {
        async query<T>(
          text: string,
          values: readonly unknown[] = []
        ): Promise<readonly T[]> {
          queries.push(text)
          if (text.includes("with due as")) {
            return claimRowsQueryResult(rows) as T[]
          }
          if (text.includes("attempt_count = greatest")) {
            releasedIds = values[1] as readonly string[]
            return releasedIds.map((id) => ({ id })) as T[]
          }
          return [{ id: "updated" }] as T[]
        },
      }
      const sender: NotificationSender = {
        send(_message, _idempotencyKey, signal) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          })
        },
      }
      const send = vi.spyOn(sender, "send")
      const startedAtMs = Date.now()
      const delivery = deliverPendingNotifications(
        {
          db,
          sender,
          appUrl: "https://pulse.example.com",
          now: () => now,
        },
        {
          concurrency: 1,
          limit: 100,
          perSendTimeoutMs: 1000,
          deadlineAtMs: startedAtMs + 1100,
        }
      )

      await vi.advanceTimersByTimeAsync(100)

      await expect(delivery).resolves.toEqual({
        claimed: 100,
        sent: 0,
        failed: 1,
        dead: 0,
        lostClaims: 0,
      })
      expect(send).toHaveBeenCalledOnce()
      expect(releasedIds).toHaveLength(99)
      expect(queries).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not claim rows after the overall deadline", async () => {
    const query = vi.fn()

    await expect(
      deliverPendingNotifications(
        {
          db: { query } as SqlExecutor,
          sender: {
            async send() {
              return { providerMessageId: "unexpected" }
            },
          },
          appUrl: "https://pulse.example.com",
        },
        { deadlineAtMs: 100, nowMs: () => 100 }
      )
    ).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      dead: 0,
      lostClaims: 0,
    })
    expect(query).not.toHaveBeenCalled()
  })

  it("bounds a stalled claim query and leaves no ambiguous claims", async () => {
    vi.useFakeTimers()
    try {
      const query = vi.fn(
        async () =>
          await new Promise<readonly never[]>(() => {
            // Simulates a database statement that only its timeout can cancel.
          })
      )
      const withStatementTimeout: NonNullable<
        SqlExecutor["withStatementTimeout"]
      > = async (timeoutMs, work) => {
        const timeout = new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error("statement timeout"), {
                  code: "57014",
                })
              ),
            timeoutMs
          )
        })
        return Promise.race([work(query), timeout])
      }
      const db: SqlExecutor = {
        query,
        withStatementTimeout,
      }
      const startedAtMs = Date.now()
      const delivery = deliverPendingNotifications(
        {
          db,
          sender: {
            async send() {
              return { providerMessageId: "unexpected" }
            },
          },
          appUrl: "https://pulse.example.com",
        },
        { deadlineAtMs: startedAtMs + 250 }
      )

      await vi.advanceTimersByTimeAsync(250)

      await expect(delivery).resolves.toEqual({
        claimed: 0,
        sent: 0,
        failed: 0,
        dead: 0,
        lostClaims: 0,
      })
      expect(Date.now() - startedAtMs).toBe(250)
      expect(query).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds a stalled release and leaves skipped claims for stale recovery", async () => {
    vi.useFakeTimers()
    try {
      const rows = Array.from({ length: 100 }, (_, index) =>
        claimed({ id: `notification-${index + 1}` })
      )
      let timedCalls = 0
      const queryFn: SqlExecutor["query"] = async <T,>(text: string) => {
        if (text.includes("with due as")) {
          return claimRowsQueryResult(rows) as T[]
        }
        if (text.includes("claimed_at <")) {
          return rows.slice(1).map((row) => ({
            id: row.id,
            status: "failed",
          })) as T[]
        }
        return [{ id: "updated" }] as T[]
      }
      const withStatementTimeout: NonNullable<
        SqlExecutor["withStatementTimeout"]
      > = async (timeoutMs, work) => {
        timedCalls += 1
        if (timedCalls <= 2) {
          return work(queryFn)
        }
        const stalledQuery: SqlExecutor["query"] = async () =>
          await new Promise<readonly never[]>(() => {
            // The timeout cancels and rolls back this release transaction.
          })
        const timeout = new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error("statement timeout"), {
                  code: "57014",
                })
              ),
            timeoutMs
          )
        })
        return Promise.race([work(stalledQuery), timeout])
      }
      const db: SqlExecutor = {
        query: queryFn,
        withStatementTimeout,
      }
      const sender: NotificationSender = {
        send(_message, _idempotencyKey, signal) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          })
        },
      }
      const startedAtMs = Date.now()
      const delivery = deliverPendingNotifications(
        { db, sender, appUrl: "https://pulse.example.com", now: () => now },
        {
          concurrency: 1,
          limit: 100,
          perSendTimeoutMs: 5000,
          deadlineAtMs: startedAtMs + 1100,
        }
      )

      await vi.advanceTimersByTimeAsync(1100)

      await expect(delivery).resolves.toEqual({
        claimed: 100,
        sent: 0,
        failed: 1,
        dead: 0,
        lostClaims: 99,
      })
      expect(Date.now() - startedAtMs).toBe(1100)
      await expect(
        reconcileStaleClaims(db, new Date(now.getTime() + 5 * 60_000 + 1))
      ).resolves.toBe(99)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { label: "sent", providerFails: false },
    { label: "failed", providerFails: true },
  ])(
    "bounds stalled $label finalization and preserves monitor reserve",
    async ({ providerFails }) => {
      vi.useFakeTimers()
      try {
        let timedCalls = 0
        const queryFn: SqlExecutor["query"] = async <T,>(text: string) => {
          if (text.includes("with due as")) {
            return claimRowsQueryResult([claimed()]) as T[]
          }
          if (text.includes("claimed_at <")) {
            return [{ id: "notification-1", status: "failed" }] as T[]
          }
          return [{ id: "updated" }] as T[]
        }
        const withStatementTimeout: NonNullable<
          SqlExecutor["withStatementTimeout"]
        > = async (timeoutMs, work) => {
          timedCalls += 1
          if (timedCalls === 1) {
            return work(queryFn)
          }
          const stalledQuery: SqlExecutor["query"] = async () =>
            await new Promise<readonly never[]>(() => {
              // The finalizer transaction is cancelled at the outer deadline.
            })
          const timeout = new Promise<never>((_resolve, reject) => {
            setTimeout(
              () =>
                reject(
                  Object.assign(new Error("statement timeout"), {
                    code: "57014",
                  })
                ),
              timeoutMs
            )
          })
          return Promise.race([work(stalledQuery), timeout])
        }
        const db: SqlExecutor = { query: queryFn, withStatementTimeout }
        const send = vi.fn(async () => {
          if (providerFails) {
            throw new NotificationProviderError("rate_limit_exceeded", {
              retryable: true,
            })
          }
          return { providerMessageId: "email-1" }
        })
        const startedAtMs = Date.now()
        const delivery = deliverPendingNotifications(
          {
            db,
            sender: { send },
            appUrl: "https://pulse.example.com",
            now: () => now,
          },
          { deadlineAtMs: startedAtMs + 1100 }
        )

        await vi.advanceTimersByTimeAsync(1100)

        await expect(delivery).resolves.toEqual({
          claimed: 1,
          sent: 0,
          failed: 0,
          dead: 0,
          lostClaims: 1,
        })
        expect(Date.now() - startedAtMs).toBe(1100)
        expect(send).toHaveBeenCalledOnce()
        await expect(
          reconcileStaleClaims(db, new Date(now.getTime() + 5 * 60_000 + 1))
        ).resolves.toBe(1)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it("marks permanent errors and exhausted retries dead", async () => {
    const permanent: NotificationSender = {
      async send() {
        throw new NotificationProviderError("invalid_from_address", {
          retryable: false,
        })
      },
    }
    const exhausted: NotificationSender = {
      async send() {
        throw new NotificationProviderError("internal_server_error", {
          retryable: true,
        })
      },
    }
    const permanentResult = await deliverPendingNotifications({
      db: dbReturning([claimed()]),
      sender: permanent,
      appUrl: "https://pulse.example.com",
      now: () => now,
    })
    const exhaustedResult = await deliverPendingNotifications({
      db: dbReturning([claimed({ attemptCount: 5 })]),
      sender: exhausted,
      appUrl: "https://pulse.example.com",
      now: () => now,
    })
    expect(permanentResult.dead).toBe(1)
    expect(exhaustedResult.dead).toBe(1)
  })

  it("caps concurrency and reports token-guarded updates that lose their claim", async () => {
    let active = 0
    let peak = 0
    const sender: NotificationSender = {
      async send() {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return { providerMessageId: "email" }
      },
    }
    const rows = Array.from({ length: 8 }, (_, index) =>
      claimed({ id: `n-${index}` })
    )
    const result = await deliverPendingNotifications(
      {
        db: dbReturning(rows, false),
        sender,
        appUrl: "https://pulse.example.com",
        now: () => now,
      },
      { concurrency: 3 }
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(result.lostClaims).toBe(8)
    expect(result.sent).toBe(0)
  })

  it("forwards eventTypes into the claim path", async () => {
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void values
      if (text.includes("with due as")) {
        return [
          {
            id: "system-1",
            incident_id: null,
            monitor_id: null,
            dependency_id: null,
            event_type: "system.alert",
            recipient: "ops@example.com",
            idempotency_key: "system-key",
            payload: {
              type: "system.alert",
              title: "Loop down",
              detail: "detail",
              reason: "stale",
              detectedAt: "2026-07-18T00:00:00.000Z",
            },
            attempt_count: 1,
            claim_token: "claim-1",
          },
        ]
      }
      return [{ id: "updated" }]
    })
    const send = vi.fn(async () => ({ providerMessageId: "email-1" }))
    const result = await deliverPendingNotifications(
      {
        db: { query } as SqlExecutor,
        sender: { send },
        appUrl: "https://pulse.example.com",
        now: () => now,
        createClaimToken: () => "claim-1",
      },
      { eventTypes: ["system.alert"], limit: 50, concurrency: 5 }
    )
    expect(result.sent).toBe(1)
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/event_type = any\(\$4\)/i),
      [now, 50, "claim-1", ["system.alert"]]
    )
  })

  it("drains a blocked provider send before surfacing bookkeeping failure", async () => {
    const slow = deferred<{ providerMessageId: string }>()
    let slowStarted = false
    let activeSends = 0

    const bookkeep = claimed({
      id: "n-bookkeep",
      idempotencyKey: "key-bookkeep",
      claimToken: "claim-bookkeep",
    })
    const blocked = claimed({
      id: "n-blocked",
      idempotencyKey: "key-blocked",
      claimToken: "claim-blocked",
    })
    const rows = [bookkeep, blocked]

    const db: SqlExecutor = {
      async query<T>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<readonly T[]> {
        if (text.includes("with due as")) {
          return claimRowsQueryResult(rows) as T[]
        }
        // markNotificationSent / markNotificationFailed bind id as $1
        if (values[0] === "n-bookkeep") {
          throw new Error("db bookkeeping down")
        }
        return [{ id: "updated" }] as T[]
      },
    }

    const sender: NotificationSender = {
      async send(_message, idempotencyKey) {
        activeSends += 1
        try {
          if (idempotencyKey === "key-blocked") {
            slowStarted = true
            return await slow.promise
          }
          return { providerMessageId: "email-fast" }
        } finally {
          activeSends -= 1
        }
      },
    }

    const done = deliverPendingNotifications(
      {
        db,
        sender,
        appUrl: "https://pulse.example.com",
        now: () => now,
        createClaimToken: () => "claim-batch",
      },
      { concurrency: 2 }
    )

    await vi.waitFor(() => {
      expect(slowStarted).toBe(true)
    })

    let settled = false
    void done.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    // Sibling still in flight: delivery must not settle early.
    expect(settled).toBe(false)
    expect(activeSends).toBe(1)

    slow.resolve({ providerMessageId: "email-slow" })

    await expect(done).rejects.toBeInstanceOf(
      NotificationDeliveryInfrastructureError
    )
    // No background sender activity after the call settles.
    expect(activeSends).toBe(0)
    expect(settled).toBe(true)

    const error = await done.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(NotificationDeliveryInfrastructureError)
    if (!(error instanceof NotificationDeliveryInfrastructureError)) {
      throw new Error("expected infrastructure error")
    }
    expect(error.notificationIds).toEqual(["n-bookkeep"])
    expect(JSON.stringify(error)).not.toContain("ops@example.com")
    // Blocked sibling completed bookkeeping after the pool drained.
    expect(error.summary).toEqual({
      claimed: 2,
      sent: 1,
      failed: 0,
      dead: 0,
      lostClaims: 0,
    })
  })

  it("keeps recorded provider failures in the summary when another row's bookkeeping fails", async () => {
    const providerFail = claimed({
      id: "n-provider-fail",
      idempotencyKey: "key-provider-fail",
      claimToken: "claim-provider-fail",
    })
    const bookkeepFail = claimed({
      id: "n-bookkeep",
      idempotencyKey: "key-bookkeep",
      claimToken: "claim-bookkeep",
    })
    const rows = [providerFail, bookkeepFail]

    const db: SqlExecutor = {
      async query<T>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<readonly T[]> {
        if (text.includes("with due as")) {
          return claimRowsQueryResult(rows) as T[]
        }
        if (values[0] === "n-bookkeep") {
          throw new Error("db bookkeeping down")
        }
        return [{ id: "updated" }] as T[]
      },
    }

    const sender: NotificationSender = {
      async send(_message, idempotencyKey) {
        if (idempotencyKey === "key-provider-fail") {
          throw new NotificationProviderError("rate_limit_exceeded", {
            retryable: true,
          })
        }
        return { providerMessageId: "email-ok" }
      },
    }

    const error = await deliverPendingNotifications(
      {
        db,
        sender,
        appUrl: "https://pulse.example.com",
        now: () => now,
      },
      { concurrency: 2 }
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(NotificationDeliveryInfrastructureError)
    if (!(error instanceof NotificationDeliveryInfrastructureError)) {
      throw new Error("expected infrastructure error")
    }
    expect(error.notificationIds).toEqual(["n-bookkeep"])
    // Provider failure was recorded via mark-failed (retry path).
    expect(error.summary).toEqual({
      claimed: 2,
      sent: 0,
      failed: 1,
      dead: 0,
      lostClaims: 0,
    })
  })

  it("records a permanent provider error as dead without treating mark-failed success as infrastructure", async () => {
    const permanent: NotificationSender = {
      async send() {
        throw new NotificationProviderError("invalid_from_address", {
          retryable: false,
        })
      },
    }
    const result = await deliverPendingNotifications({
      db: dbReturning([claimed()]),
      sender: permanent,
      appUrl: "https://pulse.example.com",
      now: () => now,
    })
    expect(result).toEqual({
      claimed: 1,
      sent: 0,
      failed: 0,
      dead: 1,
      lostClaims: 0,
    })
  })
})
