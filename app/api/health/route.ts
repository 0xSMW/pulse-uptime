import { queryExecutor } from "@/lib/db/query-executor"

export const dynamic = "force-dynamic"

const DB_PROBE_TIMEOUT_MS = 2500

// Public and unauthenticated by design. It reveals a single bit, database
// reachable or not, which the public status page already exposes through its
// degraded shell. The error boundary uses it to explain failures precisely.
// Statement timeout bounds the probe on the server. No Promise.race around
// uncancelled SQL.
export async function GET() {
  let database: "ok" | "unreachable" = "ok"
  try {
    await queryExecutor.withStatementTimeout(DB_PROBE_TIMEOUT_MS, (query) =>
      query("select 1", [])
    )
  } catch {
    database = "unreachable"
  }
  return Response.json(
    { app: "ok", database },
    { headers: { "cache-control": "no-store" } }
  )
}
