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
   * One connection and wall-clock deadline for acquisition plus transaction
   * work. SET LOCAL statement_timeout receives the remaining budget.
   */
  withStatementTimeout: <T>(
    timeoutMs: number,
    work: (query: QueryFn) => Promise<T>
  ) => Promise<T>
}

function statementBudgetError(): Error & { code: "57014" } {
  return Object.assign(
    new Error("canceling statement due to statement timeout"),
    { code: "57014" as const }
  )
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
  // Reserve one connection for the whole work block. The wall-clock timer also
  // bounds pool queueing and connection setup before statement_timeout exists.
  async withStatementTimeout(timeoutMs, work) {
    const timeout = Math.max(1, Math.floor(timeoutMs))
    const deadlineAtMs = Date.now() + timeout
    const timeoutError = statementBudgetError()
    let expired = false
    const activeQueries = new Set<{ cancel: () => void }>()
    let timeoutId: ReturnType<typeof setTimeout>

    const deadline = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        expired = true
        for (const query of activeQueries) {
          query.cancel()
        }
        reject(timeoutError)
      }, timeout)
    })

    const transaction = (async () => {
      const connection = await sql.reserve()
      let began = false

      const remainingMs = () => Math.floor(deadlineAtMs - Date.now())
      const assertWithinDeadline = () => {
        if (expired || remainingMs() <= 0) {
          throw timeoutError
        }
      }
      const run = async <R>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<readonly R[]> => {
        assertWithinDeadline()
        const pending = connection.unsafe(
          text,
          portableQueryValues(values) as never[]
        )
        activeQueries.add(pending)
        try {
          return (await pending) as unknown as readonly R[]
        } finally {
          activeQueries.delete(pending)
        }
      }

      try {
        await run("begin")
        began = true
        await run(`select set_config('statement_timeout', $1, true)`, [
          String(Math.max(1, remainingMs())),
        ])
        const query: QueryFn = (text, values) => run(text, values)
        const result = await work(query)
        assertWithinDeadline()
        await run("commit")
        began = false
        return result
      } catch (error) {
        if (began) {
          try {
            await connection.unsafe("rollback", [])
          } catch {
            // The deadline error remains the useful failure for the caller.
          }
        }
        throw error
      } finally {
        connection.release()
      }
    })()

    try {
      return await Promise.race([transaction, deadline])
    } finally {
      clearTimeout(timeoutId!)
    }
  },
}
