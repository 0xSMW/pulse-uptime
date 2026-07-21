export const readinessSystems = ["vercel", "database", "edge", "email"] as const

type ReadinessSystem = (typeof readinessSystems)[number]
type ReadinessState = "ready" | "warning" | "blocked"

export interface ReadinessResult {
  system: ReadinessSystem
  state: ReadinessState
  code: string
  remediation?: string
}

export interface ReadinessReport {
  checkedAt: string
  expiresAt: string
  canContinue: boolean
  requiresEmailAcknowledgement: boolean
  checks: ReadinessResult[]
}

/** Absolute wall-clock deadline and abort for every provider probe. */
export interface ReadinessProbeOptions {
  deadlineAtMs: number
  signal: AbortSignal
}

export type ReadinessProbe = (
  options: ReadinessProbeOptions
) => Promise<ReadinessResult>
