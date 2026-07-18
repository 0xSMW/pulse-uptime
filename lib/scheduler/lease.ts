export const LEASE_DURATION_MS = 90_000;
export const MONITORING_LEASE = "monitor-check";
export const MAINTENANCE_LEASE = "maintenance";

export interface LeaseStore {
  acquire(name: string, ownerId: string, durationMs: number): Promise<boolean>;
  release(name: string, ownerId: string): Promise<void>;
}

export async function withLease<T>(
  store: LeaseStore,
  name: string,
  ownerId: string,
  now: Date,
  work: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  void now;
  if (!await store.acquire(name, ownerId, LEASE_DURATION_MS)) return { acquired: false };
  try {
    return { acquired: true, value: await work() };
  } finally {
    await store.release(name, ownerId);
  }
}
