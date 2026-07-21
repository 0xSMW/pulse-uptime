import { describe, expect, it, vi } from "vitest"

import {
  abortSignalForDeadline,
  createDeadline,
  deadlineCanStart,
  deadlineIsExpired,
  deadlineRemainingMs,
} from "./deadline"

describe("deadlineRemainingMs / deadlineCanStart / deadlineIsExpired", () => {
  it("reports remaining budget against an absolute deadline", () => {
    expect(deadlineRemainingMs(10_000, 2500)).toBe(7500)
    expect(deadlineRemainingMs(10_000, 10_000)).toBe(0)
    expect(deadlineRemainingMs(10_000, 12_000)).toBe(0)
  })

  it("treats non-finite values as exhausted", () => {
    expect(deadlineRemainingMs(Number.NaN, 0)).toBe(0)
    expect(deadlineRemainingMs(1000, Number.POSITIVE_INFINITY)).toBe(0)
    expect(deadlineIsExpired(Number.NaN, 0)).toBe(true)
  })

  it("canStart requires minimum remaining budget", () => {
    expect(deadlineCanStart(10_000, 500, 9400)).toBe(true)
    expect(deadlineCanStart(10_000, 500, 9600)).toBe(false)
    expect(deadlineIsExpired(10_000, 9999)).toBe(false)
    expect(deadlineIsExpired(10_000, 10_000)).toBe(true)
  })
})

describe("abortSignalForDeadline", () => {
  it("aborts immediately when the deadline is already past", () => {
    const signal = abortSignalForDeadline(1000, 1000)
    expect(signal.aborted).toBe(true)
  })

  it("delegates remaining duration to AbortSignal.timeout", () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal)
    try {
      const signal = abortSignalForDeadline(5000, 2000)
      expect(timeout).toHaveBeenCalledWith(3000)
      expect(signal.aborted).toBe(false)
    } finally {
      timeout.mockRestore()
    }
  })
})

describe("createDeadline", () => {
  it("uses a shared clock and absolute deadlineAtMs", () => {
    let clock = 1000
    const deadline = createDeadline(5000, { nowMs: () => clock })
    expect(deadline.deadlineAtMs).toBe(5000)
    expect(deadline.remainingMs()).toBe(4000)
    expect(deadline.canStart(3500)).toBe(true)
    clock = 2000
    expect(deadline.remainingMs()).toBe(3000)
    expect(deadline.canStart(3500)).toBe(false)
    clock = 5000
    expect(deadline.isExpired()).toBe(true)
    expect(deadline.abortSignal().aborted).toBe(true)
  })

  it("allows an explicit nowMs override on each call", () => {
    const deadline = createDeadline(10_000, { nowMs: () => 0 })
    expect(deadline.remainingMs(2500)).toBe(7500)
    expect(deadline.canStart(1000, 9500)).toBe(false)
  })
})
