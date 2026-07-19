import { sql } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const DB_PROBE_TIMEOUT_MS = 2_500;

// Public and unauthenticated by design. It reveals a single bit, database
// reachable or not, which the public status page already exposes through its
// degraded shell. The error boundary uses it to explain failures precisely.
export async function GET() {
  let database: "ok" | "unreachable" = "ok";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sql`select 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), DB_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    database = "unreachable";
  } finally {
    clearTimeout(timer);
  }
  return Response.json(
    { app: "ok", database },
    { headers: { "cache-control": "no-store" } },
  );
}
