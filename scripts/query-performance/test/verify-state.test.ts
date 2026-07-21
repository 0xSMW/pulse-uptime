import { describe, expect, it } from "vitest"

import { FIXTURE_VERSION } from "../src/fixture-constants"
import {
  ACCEPTED_CONFIG_NON_FIXTURE_RESIDUE_SQL,
  evaluateSafeScope,
  passesRetainedStateCliGate,
  type RetainedStateProof,
} from "../src/verify-state"

function exactFixtureProof(
  overrides: Partial<RetainedStateProof> = {}
): RetainedStateProof {
  return {
    projectId: "fake-project",
    regionId: "fake-region",
    fixtureVersion: FIXTURE_VERSION,
    seededAt: new Date(0).toISOString(),
    monitorCountExpected: 100,
    monitorCountUntaggedResidue: 0,
    acceptedConfigNonFixtureResidue: 0,
    tables: [
      {
        table: "monitoring_config_snapshots",
        expected: 2,
        actual: 2,
        matches: true,
        nonZero: true,
      },
    ],
    allMatch: true,
    allNonZero: true,
    safeScope: true,
    ...overrides,
  }
}

describe("ACCEPTED_CONFIG_NON_FIXTURE_RESIDUE_SQL", () => {
  it("counts accepted snapshots outside the fixture source tag", () => {
    const sql = ACCEPTED_CONFIG_NON_FIXTURE_RESIDUE_SQL.toLowerCase()
    expect(sql).toContain("monitoring_config_snapshots")
    expect(sql).toContain("status = 'accepted'")
    expect(sql).toMatch(/source is distinct from 'qh-fixture'/)
    expect(sql).toContain("count(*)")
  })

  it("does not restrict the scan to fixture rows only", () => {
    // Scan globally, then exclude fixture rows.
    const sql = ACCEPTED_CONFIG_NON_FIXTURE_RESIDUE_SQL.toLowerCase()
    expect(sql).not.toMatch(/where source = 'qh-fixture'/)
    expect(sql).not.toMatch(/and source = 'qh-fixture'/)
  })
})

describe("evaluateSafeScope", () => {
  it("passes for exact fixture state with zero untagged and zero non-fixture accepted residue", () => {
    expect(
      evaluateSafeScope({
        monitorCountUntaggedResidue: 0,
        acceptedConfigNonFixtureResidue: 0,
      })
    ).toBe(true)
  })

  it("fails when non-fixture accepted snapshots remain selectable", () => {
    expect(
      evaluateSafeScope({
        monitorCountUntaggedResidue: 0,
        acceptedConfigNonFixtureResidue: 1,
      })
    ).toBe(false)
  })

  it("fails when untagged monitor residue remains", () => {
    expect(
      evaluateSafeScope({
        monitorCountUntaggedResidue: 2,
        acceptedConfigNonFixtureResidue: 0,
      })
    ).toBe(false)
  })

  it("fails when both residue kinds are present", () => {
    expect(
      evaluateSafeScope({
        monitorCountUntaggedResidue: 1,
        acceptedConfigNonFixtureResidue: 3,
      })
    ).toBe(false)
  })
})

describe("passesRetainedStateCliGate", () => {
  it("passes for exact fixture state at the current version", () => {
    const proof = exactFixtureProof({
      safeScope: evaluateSafeScope({
        monitorCountUntaggedResidue: 0,
        acceptedConfigNonFixtureResidue: 0,
      }),
    })
    expect(passesRetainedStateCliGate(proof)).toBe(true)
  })

  it("fails through the existing safeScope gate when non-fixture accepted residue is present", () => {
    const acceptedConfigNonFixtureResidue = 2
    const proof = exactFixtureProof({
      acceptedConfigNonFixtureResidue,
      safeScope: evaluateSafeScope({
        monitorCountUntaggedResidue: 0,
        acceptedConfigNonFixtureResidue,
      }),
    })
    expect(proof.safeScope).toBe(false)
    expect(passesRetainedStateCliGate(proof)).toBe(false)
  })

  it("still fails for cardinality, empty tables, and version mismatches", () => {
    expect(
      passesRetainedStateCliGate(exactFixtureProof({ allMatch: false }))
    ).toBe(false)
    expect(
      passesRetainedStateCliGate(exactFixtureProof({ allNonZero: false }))
    ).toBe(false)
    expect(
      passesRetainedStateCliGate(
        exactFixtureProof({ fixtureVersion: FIXTURE_VERSION + 1 })
      )
    ).toBe(false)
    expect(
      passesRetainedStateCliGate(exactFixtureProof({ fixtureVersion: null }))
    ).toBe(false)
  })
})
