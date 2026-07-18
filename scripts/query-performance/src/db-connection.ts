// The single place every command gets a live database handle from. Every
// caller goes through `withConnection`, which loads the connection string
// exclusively from `.query-performance/` (see local-state.ts) and then
// verifies the live server actually is the pinned temp project before
// handing back a client. Nothing in this file, or anything downstream of it,
// reads DATABASE_URL / DATABASE_URL_UNPOOLED or accepts a URL as an argument.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "../../../lib/db/schema";
import { loadTempProjectState, LocalStateError, type TempProjectState } from "./local-state";

export class SafetyGateError extends Error {}

export interface GatedConnection {
  readonly project: TempProjectState;
  readonly sql: postgres.Sql;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
}

async function verifyIdentity(sql: postgres.Sql, project: TempProjectState): Promise<void> {
  let rows: Array<{ datname: string }>;
  try {
    rows = await sql<Array<{ datname: string }>>`select current_database() as datname`;
  } catch (cause) {
    throw new SafetyGateError(
      `Could not connect to verify database identity before running any benchmark query: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  const datname = rows[0]?.datname;
  if (!datname || datname !== project.database) {
    throw new SafetyGateError(
      "Connected database name does not match the recorded temp project database. Refusing to proceed.",
    );
  }
}

/**
 * Opens a connection to the pinned temp Neon project, verifies its identity,
 * runs `fn`, and always closes the connection afterward — including on
 * throw, so a failed benchmark run never leaks an open connection.
 */
export async function withConnection<T>(
  fn: (conn: GatedConnection) => Promise<T>,
): Promise<T> {
  let state: { project: TempProjectState; connectionString: string };
  try {
    state = loadTempProjectState();
  } catch (error) {
    if (error instanceof LocalStateError) {
      throw new SafetyGateError(error.message);
    }
    throw error;
  }

  const sql = postgres(state.connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: "require",
  });
  try {
    await verifyIdentity(sql, state.project);
    const db = drizzle(sql, { schema });
    return await fn({ project: state.project, sql, db });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
