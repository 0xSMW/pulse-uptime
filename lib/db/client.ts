import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseHandle = Database | DatabaseTransaction;
