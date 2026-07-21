import { withConnection } from "./db-connection"
import { resetFixture } from "./fixtures"

async function main() {
  await withConnection((conn) => resetFixture(conn))
  console.log("[reset-fixture] fixture-tagged rows removed.")
}

main().catch((error) => {
  console.error(
    "[reset-fixture] failed:",
    error instanceof Error ? error.message : error
  )
  process.exitCode = 1
})
