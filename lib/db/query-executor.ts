import "server-only"

import { sql } from "@/lib/db/client"
import { portableQueryValues } from "@/lib/db/query-values"

export type QueryFn = <T>(
  text: string,
  values: readonly unknown[]
) => Promise<readonly T[]>

/**
 * Neutral SQL surface shared by cron runtimes and maintenance.
 * Compatible with notifications SqlExecutor (query only) and the optional
 * withStatementTimeout shape on maintenance QueryExecutor.
 */
export interface QueryExecutor {
  query: QueryFn
  /**
   * One connection for the whole work block so SET LOCAL statement_timeout
   * applies to the SQL that follows inside the same transaction.
   */
  withStatementTimeout: <T>(
    timeoutMs: number,
    work: (query: QueryFn) => Promise<T>
  ) => Promise<T>
}

export const queryExecutor: QueryExecutor = {
  async query<T>(
    text: string,
    values: readonly unknown[]
  ): Promise<readonly T[]> {
    return (await sql.unsafe(
      text,
      portableQueryValues(values) as never[]
    )) as unknown as readonly T[]
  },
  // One connection for the whole work block so SET LOCAL statement_timeout
  // applies to the maintenance SQL that follows inside the same transaction.
  async withStatementTimeout(timeoutMs, work) {
    return sql.begin(async (tx) => {
      const timeout = Math.max(1, Math.floor(timeoutMs))
      await tx.unsafe(`select set_config('statement_timeout', $1, true)`, [
        String(timeout),
      ] as never[])
      const query: QueryFn = async <R>(
        text: string,
        values: readonly unknown[]
      ): Promise<readonly R[]> =>
        (await tx.unsafe(
          text,
          portableQueryValues(values) as never[]
        )) as unknown as readonly R[]
      return work(query)
    }) as Promise<ReturnType<typeof work>>
  },
}
