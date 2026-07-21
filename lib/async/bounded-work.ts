export type SettledWorkOutcome<TResult> =
  | { status: "fulfilled"; value: TResult }
  | { status: "rejected"; reason: unknown }
  | { status: "skipped" }

export interface BoundedWorkOptions<TItem, TResult> {
  concurrency: number
  worker: (item: TItem, index: number) => Promise<TResult>
  /** When aborted, no new items start. Already started work still finishes. */
  signal?: AbortSignal
  /** When true, no new items start. Checked before each claim. */
  shouldStop?: () => boolean
}

/**
 * Runs items with a fixed concurrency limit and returns settled outcomes in
 * input order. Task failures are caught per item. Started work always finishes
 * before return. Unstarted items (stop / abort) are `skipped`. Never closes
 * external resources and never rejects for worker failures.
 */
export async function runBoundedWork<TItem, TResult>(
  items: readonly TItem[],
  options: BoundedWorkOptions<TItem, TResult>
): Promise<readonly SettledWorkOutcome<TResult>[]> {
  const { concurrency, worker, signal, shouldStop } = options
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer")
  }

  const results: SettledWorkOutcome<TResult>[] = Array.from(
    { length: items.length },
    () => ({ status: "skipped" })
  )
  if (items.length === 0) {
    return results
  }

  let cursor = 0
  let stopStarting = false

  const claimNext = (): number | null => {
    if (stopStarting) {
      return null
    }
    if (signal?.aborted || shouldStop?.()) {
      stopStarting = true
      return null
    }
    if (cursor >= items.length) {
      return null
    }
    const index = cursor
    cursor += 1
    return index
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      let index = claimNext()
      while (index !== null) {
        const item = items[index]
        if (item !== undefined) {
          try {
            const value = await worker(item, index)
            results[index] = { status: "fulfilled", value }
          } catch (reason) {
            results[index] = { status: "rejected", reason }
          }
        }
        index = claimNext()
      }
    }
  )

  // Wait for every started runner even when individual tasks reject.
  await Promise.all(runners)
  return results
}
