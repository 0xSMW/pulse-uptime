import { withConnection } from "./db-connection";
import { seedFixture } from "./fixtures";

async function main() {
  const cardinalities = await withConnection((conn) => seedFixture(conn));
  console.log("[seed-fixture] fixture seeded (idempotent — reruns reset and reinsert):");
  console.log(JSON.stringify(cardinalities, null, 2));
}

main().catch((error) => {
  console.error("[seed-fixture] failed:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
