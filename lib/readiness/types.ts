export const readinessSystems = ["vercel", "database", "edge", "email"] as const

export type ReadinessSystem = (typeof readinessSystems)[number]
export type ReadinessState = "ready" | "warning" | "blocked"

export type ReadinessResult = {
  system: ReadinessSystem
  state: ReadinessState
  code: string
  remediation?: string
}

export type ReadinessReport = {
  checkedAt: string
  expiresAt: string
  canContinue: boolean
  requiresEmailAcknowledgement: boolean
  checks: ReadinessResult[]
}

export type ReadinessProbe = () => Promise<ReadinessResult>
