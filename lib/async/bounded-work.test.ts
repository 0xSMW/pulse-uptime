import { describe, expect, it, vi } from "vitest"

import { runBoundedWork } from "./bounded-work"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("runBoundedWork", () => {
  it("preserves input order across mixed success and failure", async () => {
    const outcomes = await runBoundedWork([1, 2, 3], {
      concurrency: 2,
      worker: async (n) => {
        if (n === 2) {
          throw new Error("boom")
        }
        return n * 10
      },
    })
    expect(outcomes).toEqual([
      { status: "fulfilled", value: 10 },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "boom" }),
      },
      { status: "fulfilled", value: 30 },
    ])
  })

  it("awaits a blocked sibling after another task fails", async () => {
    const slow = deferred<string>()
    let slowStarted = false
    let fastFinished = false

    const done = runBoundedWork(["fast", "slow"], {
      concurrency: 2,
      worker: async (item) => {
        if (item === "fast") {
          await Promise.resolve()
          fastFinished = true
          throw new Error("fast failed")
        }
        slowStarted = true
        return slow.promise
      },
    })

    await vi.waitFor(() => {
      expect(slowStarted).toBe(true)
      expect(fastFinished).toBe(true)
    })

    // Pool has not returned while the sibling is still in flight.
    let settled = false
    void done.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    slow.resolve("ok")
    await expect(done).resolves.toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "fast failed" }),
      },
      { status: "fulfilled", value: "ok" },
    ])
  })

  it("starts no new task after shouldStop becomes true", async () => {
    const gate = deferred()
    let stop = false
    const started: number[] = []

    const done = runBoundedWork([1, 2, 3, 4], {
      concurrency: 1,
      shouldStop: () => stop,
      worker: async (n) => {
        started.push(n)
        if (n === 1) {
          await gate.promise
        }
        return n
      },
    })

    await vi.waitFor(() => expect(started).toEqual([1]))
    stop = true
    gate.resolve()

    const outcomes = await done
    expect(started).toEqual([1])
    expect(outcomes).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "skipped" },
      { status: "skipped" },
      { status: "skipped" },
    ])
  })

  it("starts no new task after abort signal fires", async () => {
    const gate = deferred()
    const controller = new AbortController()
    const started: number[] = []

    const done = runBoundedWork([1, 2, 3], {
      concurrency: 1,
      signal: controller.signal,
      worker: async (n) => {
        started.push(n)
        if (n === 1) {
          await gate.promise
        }
        return n
      },
    })

    await vi.waitFor(() => expect(started).toEqual([1]))
    controller.abort()
    gate.resolve()

    const outcomes = await done
    expect(started).toEqual([1])
    expect(outcomes.map((o) => o.status)).toEqual([
      "fulfilled",
      "skipped",
      "skipped",
    ])
  })

  it("never exceeds the configured concurrency limit", async () => {
    let running = 0
    let peak = 0
    const outcomes = await runBoundedWork(
      Array.from({ length: 20 }, (_, i) => i),
      {
        concurrency: 3,
        worker: async (n) => {
          running += 1
          peak = Math.max(peak, running)
          await Promise.resolve()
          running -= 1
          return n
        },
      }
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true)
  })

  it("rejects invalid concurrency before starting work", async () => {
    const worker = vi.fn()
    await expect(
      runBoundedWork([1], { concurrency: 0, worker })
    ).rejects.toThrow(/positive integer/)
    await expect(
      runBoundedWork([1], { concurrency: 1.5, worker })
    ).rejects.toThrow(/positive integer/)
    expect(worker).not.toHaveBeenCalled()
  })

  it("returns an empty list for empty input", async () => {
    await expect(
      runBoundedWork([], {
        concurrency: 4,
        worker: async () => 1,
      })
    ).resolves.toEqual([])
  })
})
