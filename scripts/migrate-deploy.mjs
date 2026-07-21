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
//   - Validates the URL shape before any network call (scheme, host, database,
//     non-pooler host, no explicit PgBouncer options).
//   - Serializes concurrent builds with a Postgres advisory lock. Two
//     overlapping builds cannot corrupt the drizzle journal. The second build
//     waits for the first, then finds no pending migrations and no-ops.

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { validateDirectMigrationUrl } from "./database-url.mjs"

// Fixed advisory lock key shared by every deploy of this project. Any constant
// works as long as it is stable across builds. Chosen to be unlikely to collide
// with application advisory locks.
const ADVISORY_LOCK_KEY = 4_072_026_001n

// Bound the wait for the lock so a stuck holder fails the build loudly instead
// of hanging it. A healthy migration run is fast, so a minute is generous.
const LOCK_WAIT_MS = 60_000
const LOCK_RETRY_MS = 2000

function log(event, extra = {}) {
  console.info(JSON.stringify({ event, ...extra }))
}

function fail(message) {
  console.error(JSON.stringify({ event: "migrate.failed", error: message }))
  process.exit(1)
}

const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/**
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {typeof postgres} [deps.connect]
 * @param {typeof drizzle} [deps.createDb]
 * @param {typeof migrate} [deps.runMigrate]
 * @param {(message: string) => void} [deps.exitWithError]
 */
export async function main({
  env = process.env,
  connect = postgres,
  createDb = drizzle,
  runMigrate = migrate,
  exitWithError = fail,
} = {}) {
  if (env.VERCEL_ENV !== "production") {
    log("migrate.skipped", {
      reason: "not-production",
      vercelEnv: env.VERCEL_ENV ?? null,
    })
    return
  }

  const rawUrl = env.DATABASE_URL_UNPOOLED
  if (!rawUrl) {
    exitWithError(
      "DATABASE_URL_UNPOOLED is not set for the production build. Add the direct " +
        "(non-pooled) Neon connection string to the Production environment in " +
        "Vercel project settings so the build can apply migrations."
    )
    return
  }

  const validated = validateDirectMigrationUrl(rawUrl)
  if (!validated.ok) {
    // Never include the raw URL (credentials / query secrets). Hostname and
    // database are only logged when parse succeeded far enough to know them.
    log("migrate.url.rejected", { code: validated.code })
    exitWithError(
      `DATABASE_URL_UNPOOLED failed validation (${validated.code}): ${validated.message}`
    )
    return
  }

  log("migrate.url.validated", {
    hostname: validated.hostname,
    database: validated.database,
  })

  // Single connection: the advisory lock is session scoped, so the lock, the
  // migrations, and the unlock must all run on the same connection.
  const sql = connect(validated.connectionString, {
    max: 1,
    onnotice: () => {
      // Intentionally ignore postgres NOTICE messages during migration.
    },
  })
  let locked = false
  try {
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      const [{ acquired }] = await sql`
        SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS acquired
      `
      if (acquired) {
        locked = true
        break
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for the migration advisory lock. Another build may " +
            "be migrating, or a previous lock holder did not release."
        )
      }
      log("migrate.lock.waiting", { retryMs: LOCK_RETRY_MS })
      await sleep(LOCK_RETRY_MS)
    }

    log("migrate.started")
    await runMigrate(createDb(sql), { migrationsFolder: "drizzle" })
    log("migrate.completed")
  } finally {
    if (locked) {
      try {
        await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`
      } catch {
        // Closing the connection releases session locks regardless.
      }
    }
    await sql.end({ timeout: 5 })
  }
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  try {
    return fileURLToPath(import.meta.url) === resolve(entry)
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error))
  })
}
