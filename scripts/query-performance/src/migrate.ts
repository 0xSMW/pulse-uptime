// Apply repository migrations to the pinned temporary project in journal order.
// Read migration files directly to keep the connection behind the safety gate.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type postgres from "postgres";

import { withConnection } from "./db-connection";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DRIZZLE_DIR = resolve(REPO_ROOT, "drizzle");

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

function loadJournal(): JournalEntry[] {
  const raw = readFileSync(resolve(DRIZZLE_DIR, "meta", "_journal.json"), "utf8");
  const journal = JSON.parse(raw) as Journal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

function loadStatements(tag: string): string[] {
  const raw = readFileSync(resolve(DRIZZLE_DIR, `${tag}.sql`), "utf8");
  return raw
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const MIGRATIONS_TABLE_SQL = `
create table if not exists "_query_perf_migrations" (
  "tag" text primary key,
  "applied_at" timestamptz not null default now()
)
`;

export interface MigrationResult {
  tag: string;
  status: "applied" | "already-applied";
}

async function applyMigrations(sql: postgres.Sql): Promise<MigrationResult[]> {
  await sql.unsafe(MIGRATIONS_TABLE_SQL);
  const applied = new Set(
    (await sql<Array<{ tag: string }>>`select tag from "_query_perf_migrations"`).map((row) => row.tag),
  );

  const results: MigrationResult[] = [];
  for (const entry of loadJournal()) {
    if (applied.has(entry.tag)) {
      results.push({ tag: entry.tag, status: "already-applied" });
      continue;
    }
    const statements = loadStatements(entry.tag);
    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      await tx`insert into "_query_perf_migrations" (tag) values (${entry.tag})`;
    });
    results.push({ tag: entry.tag, status: "applied" });
  }
  return results;
}

export async function runMigrate(): Promise<MigrationResult[]> {
  return withConnection(async ({ sql }) => applyMigrations(sql));
}

async function main() {
  const results = await runMigrate();
  for (const result of results) {
    console.log(`[migrate] ${result.tag}: ${result.status}`);
  }
  console.log(`[migrate] done — ${results.length} migration(s) tracked.`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error("[migrate] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
