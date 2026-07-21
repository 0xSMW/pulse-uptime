/**
 * Absolute wall-clock deadline helpers. Budget is always milliseconds until
 * `deadlineAtMs`. Do not invent a parallel duration-from-start model here.
 */

export function deadlineRemainingMs(
  deadlineAtMs: number,
  nowMs: number = Date.now()
): number {
  if (!(Number.isFinite(deadlineAtMs) && Number.isFinite(nowMs))) {
    return 0
  }
  return Math.max(0, deadlineAtMs - nowMs)
}

/** True when at least `minimumMs` remains before the absolute deadline. */
export function deadlineCanStart(
  deadlineAtMs: number,
  minimumMs: number,
  nowMs: number = Date.now()
): boolean {
  return deadlineRemainingMs(deadlineAtMs, nowMs) >= minimumMs
}

export function deadlineIsExpired(
  deadlineAtMs: number,
  nowMs: number = Date.now()
): boolean {
  if (!(Number.isFinite(deadlineAtMs) && Number.isFinite(nowMs))) {
    return true
  }
  return nowMs >= deadlineAtMs
}

/**
 * AbortSignal for fetch/IO that fires when the absolute deadline is reached.
 * Already-expired deadlines abort immediately. Does not close external resources.
 */
export function abortSignalForDeadline(
  deadlineAtMs: number,
  nowMs: number = Date.now()
): AbortSignal {
  const remaining = deadlineRemainingMs(deadlineAtMs, nowMs)
  if (remaining <= 0) {
    const controller = new AbortController()
    controller.abort()
    return controller.signal
  }
  return AbortSignal.timeout(remaining)
}

export interface Deadline {
  readonly deadlineAtMs: number
  remainingMs: (nowMs?: number) => number
  canStart: (minimumMs: number, nowMs?: number) => boolean
  isExpired: (nowMs?: number) => boolean
  abortSignal: (nowMs?: number) => AbortSignal
}

export function createDeadline(
  deadlineAtMs: number,
  options: { nowMs?: () => number } = {}
): Deadline {
  const defaultNow = options.nowMs ?? (() => Date.now())
  const at = (nowMs?: number) => nowMs ?? defaultNow()
  return {
    deadlineAtMs,
    remainingMs(nowMs) {
      return deadlineRemainingMs(deadlineAtMs, at(nowMs))
    },
    canStart(minimumMs, nowMs) {
      return deadlineCanStart(deadlineAtMs, minimumMs, at(nowMs))
    },
    isExpired(nowMs) {
      return deadlineIsExpired(deadlineAtMs, at(nowMs))
    },
    abortSignal(nowMs) {
      return abortSignalForDeadline(deadlineAtMs, at(nowMs))
    },
  }
}
