export const LEASE_DURATION_MS = 90_000
export const MONITORING_LEASE = "monitor-check"
export const MAINTENANCE_LEASE = "maintenance"
export const DEPENDENCY_LEASE = "dependency-check"

export interface LeaseStore {
  acquire: (
    name: string,
    ownerId: string,
    durationMs: number
  ) => Promise<boolean>
  release: (name: string, ownerId: string) => Promise<void>
}

function logLeaseReleaseFailed(
  name: string,
  ownerId: string,
  releaseError: unknown
): void {
  console.warn(
    JSON.stringify({
      event: "cron.lease_release_failed",
      leaseName: name,
      ownerId,
      error:
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError),
    })
  )
}

export async function withLease<T>(
  store: LeaseStore,
  name: string,
  ownerId: string,
  now: Date,
  work: () => Promise<T>
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  void now
  if (!(await store.acquire(name, ownerId, LEASE_DURATION_MS))) {
    return { acquired: false }
  }

  // Release failures must not mask work success or the original work error.
  // The lease still expires under LEASE_DURATION_MS if release never lands.
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await work() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  try {
    await store.release(name, ownerId)
  } catch (releaseError) {
    logLeaseReleaseFailed(name, ownerId, releaseError)
  }

  if (!outcome.ok) {
    throw outcome.error
  }
  return { acquired: true, value: outcome.value }
}
