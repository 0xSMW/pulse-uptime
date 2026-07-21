import "server-only"

import { sql as drizzleSql } from "drizzle-orm"

import { db } from "@/lib/db/client"
import { adminUsers } from "@/lib/db/schema"
import {
  createDatabaseProbe,
  createEdgeConfigProbe,
  createEmailProbe,
  createVercelProbe,
} from "@/lib/readiness/probes"
import { runReadinessChecks, withTimeout } from "@/lib/readiness/service"
import type { ReadinessResult } from "@/lib/readiness/types"

const OUTER_TIMEOUT_MS = 9000

export async function checkOnboardingReadiness() {
  const probes = {
    vercel: createVercelProbe(),
    database: createDatabaseProbe(probeDatabase),
    edge: createEdgeConfigProbe(),
    email: createEmailProbe(),
  }

  return runReadinessChecks(
    Object.fromEntries(
      Object.entries(probes).map(([system, probe]) => [
        system,
        () =>
          withTimeout(
            probe(),
            OUTER_TIMEOUT_MS,
            timeoutResult(system as keyof typeof probes)
          ),
      ])
    ) as typeof probes
  )
}

async function probeDatabase() {
  await db.select({ id: adminUsers.id }).from(adminUsers).limit(1)
  const rollback = new Error("READINESS_ROLLBACK")
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`create temporary table pulse_readiness_probe (id integer) on commit drop`
      )
      await tx.execute(
        drizzleSql`insert into pulse_readiness_probe (id) values (1)`
      )
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) {
      throw error
    }
  }
}

function timeoutResult(
  system: "vercel" | "database" | "edge" | "email"
): ReadinessResult {
  return system === "email"
    ? {
        system,
        state: "warning",
        code: "EMAIL_TIMEOUT",
        remediation: "Verify your Resend sender",
      }
    : {
        system,
        state: "blocked",
        code: `${system.toUpperCase()}_TIMEOUT`,
        remediation: remediation[system],
      }
}

const remediation = {
  vercel: "Complete the Vercel environment setup",
  database: "Check Neon connectivity and migrations",
  edge: "Check Edge Config read and write access",
}
