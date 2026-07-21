import type { QueryCaseResult } from "./explain"
import type { FixtureCardinalities } from "./fixture-constants"
import type { ExcludedQuery } from "./query-cases"

export interface Artifact {
  schemaVersion: 1
  label: string
  createdAt: string
  projectId: string
  regionId: string
  fixture: { version: number; cardinalities: FixtureCardinalities }
  run: { warmupCount: number; repeatCount: number }
  results: QueryCaseResult[]
  excluded: ExcludedQuery[]
}
