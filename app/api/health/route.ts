import {
  createLocalAdmissionControl,
  localAdmissionSourceKey,
} from "@/lib/api/local-admission"
import { queryExecutor } from "@/lib/db/query-executor"

export const dynamic = "force-dynamic"

const DB_PROBE_TIMEOUT_MS = 2500
const DB_PROBE_CACHE_TTL_MS = 1000
const HEALTH_ADMISSION_LIMIT = 60

const healthAdmission = createLocalAdmissionControl({
  limit: HEALTH_ADMISSION_LIMIT,
  maxEntries: 4096,
  windowMs: 60_000,
})

let cachedDatabaseStatus: {
  expiresAtMs: number
  status: "ok" | "unreachable"
} | null = null
let databaseProbeInFlight: Promise<"ok" | "unreachable"> | null = null

// Public and unauthenticated by design. It reveals a single bit, database
// reachable or not, which the public status page already exposes through its
// degraded shell. The error boundary uses it to explain failures precisely.
// One wall-clock deadline covers connection acquisition and cancels active SQL.
export async function GET(request: Request) {
  const admission = healthAdmission.check(localAdmissionSourceKey(request))
  if (!admission.allowed) {
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(admission.retryAfterSeconds),
        },
      }
    )
  }

  const database = await getDatabaseStatus()
  return Response.json(
    { app: "ok", database },
    { headers: { "cache-control": "no-store" } }
  )
}

async function getDatabaseStatus(): Promise<"ok" | "unreachable"> {
  const nowMs = Date.now()
  if (cachedDatabaseStatus && cachedDatabaseStatus.expiresAtMs > nowMs) {
    return cachedDatabaseStatus.status
  }
  if (databaseProbeInFlight) {
    return databaseProbeInFlight
  }

  databaseProbeInFlight = probeDatabase().then((status) => {
    cachedDatabaseStatus = {
      expiresAtMs: Date.now() + DB_PROBE_CACHE_TTL_MS,
      status,
    }
    return status
  })

  try {
    return await databaseProbeInFlight
  } finally {
    databaseProbeInFlight = null
  }
}

async function probeDatabase(): Promise<"ok" | "unreachable"> {
  try {
    await queryExecutor.withStatementTimeout(DB_PROBE_TIMEOUT_MS, (query) =>
      query("select 1", [])
    )
    return "ok"
  } catch {
    return "unreachable"
  }
}

export function resetHealthAdmissionForTests(): void {
  healthAdmission.reset()
  cachedDatabaseStatus = null
  databaseProbeInFlight = null
}
