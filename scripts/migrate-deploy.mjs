// Migrate-before-traffic gate.
//
// Vercel promotes a production deployment the moment its build finishes, so the
// new code serves before drizzle migrations run. This script closes that gap by
// applying pending migrations during the production build, before `next build`
// produces the artifact that will serve traffic. A failed migration exits
// non-zero and fails the build, so the previous deployment keeps serving.
//
// Guards:
//   - Runs migrations only when VERCEL_ENV=production. Preview and local builds
//     log a skip and exit 0 so they never touch the production database.
//   - Requires DATABASE_URL_UNPOOLED (the direct, non-pooled Neon connection).
//     Advisory locks and DDL are session scoped and unreliable over the pooled
//     endpoint, so a pooled URL is refused rather than used as a fallback.
//   - Serializes concurrent builds with a Postgres advisory lock. Two
//     overlapping builds cannot corrupt the drizzle journal. The second build
//     waits for the first, then finds no pending migrations and no-ops.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Fixed advisory lock key shared by every deploy of this project. Any constant
// works as long as it is stable across builds. Chosen to be unlikely to collide
// with application advisory locks.
const ADVISORY_LOCK_KEY = 4_072_026_001n;

// Bound the wait for the lock so a stuck holder fails the build loudly instead
// of hanging it. A healthy migration run is fast, so a minute is generous.
const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 2_000;

function log(event, extra = {}) {
  console.info(JSON.stringify({ event, ...extra }));
}

function fail(message) {
  console.error(JSON.stringify({ event: "migrate.failed", error: message }));
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (process.env.VERCEL_ENV !== "production") {
    log("migrate.skipped", {
      reason: "not-production",
      vercelEnv: process.env.VERCEL_ENV ?? null,
    });
    return;
  }

  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    fail(
      "DATABASE_URL_UNPOOLED is not set for the production build. Add the direct " +
        "(non-pooled) Neon connection string to the Production environment in " +
        "Vercel project settings so the build can apply migrations.",
    );
  }

  // Single connection: the advisory lock is session scoped, so the lock, the
  // migrations, and the unlock must all run on the same connection.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let locked = false;
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const [{ acquired }] = await sql`
        SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS acquired
      `;
      if (acquired) {
        locked = true;
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for the migration advisory lock. Another build may " +
            "be migrating, or a previous lock holder did not release.",
        );
      }
      log("migrate.lock.waiting", { retryMs: LOCK_RETRY_MS });
      await sleep(LOCK_RETRY_MS);
    }

    log("migrate.started");
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    log("migrate.completed");
  } finally {
    if (locked) {
      try {
        await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
      } catch {
        // Closing the connection releases session locks regardless.
      }
    }
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
