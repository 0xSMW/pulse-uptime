import { randomUUID } from "node:crypto";
import { InvalidNotificationPayloadError, createNotificationMessage } from "./message";
import { NotificationProviderError, type NotificationSender } from "./provider";
import {
  claimNotifications,
  markNotificationFailed,
  markNotificationSent,
  type SqlExecutor,
} from "./sql";
import type { ClaimedNotification, NotificationLogger } from "./types";

export const MAX_DELIVERY_ATTEMPTS = 5;
export const MAX_CLAIM_BATCH_SIZE = 100;
export const MAX_SEND_CONCURRENCY = 10;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export function retryAt(now: Date, attemptCount: number): Date {
  const index = Math.max(0, Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1));
  return new Date(now.getTime() + RETRY_DELAYS_MS[index]);
}

export interface DeliveryDependencies {
  db: SqlExecutor;
  sender: NotificationSender;
  appUrl: string;
  log?: NotificationLogger;
  now?: () => Date;
  createClaimToken?: () => string;
}

export interface DeliverySummary {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  lostClaims: number;
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item) await worker(item);
    }
  });
  await Promise.all(runners);
}

function safeFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof NotificationProviderError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof InvalidNotificationPayloadError) {
    return { code: error.code, retryable: false };
  }
  return { code: "PROVIDER_UNAVAILABLE", retryable: true };
}

export async function deliverPendingNotifications(
  dependencies: DeliveryDependencies,
  options: { limit?: number; concurrency?: number } = {},
): Promise<DeliverySummary> {
  const limit = options.limit ?? 50;
  const concurrency = options.concurrency ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_BATCH_SIZE) {
    throw new RangeError("Delivery limit must be between 1 and 100");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_SEND_CONCURRENCY) {
    throw new RangeError("Delivery concurrency must be between 1 and 10");
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const rows = await claimNotifications(dependencies.db, {
    now,
    limit,
    claimToken: (dependencies.createClaimToken ?? randomUUID)(),
  });
  const summary: DeliverySummary = {
    claimed: rows.length,
    sent: 0,
    failed: 0,
    dead: 0,
    lostClaims: 0,
  };

  await runBounded(rows, concurrency, async (row: ClaimedNotification) => {
    try {
      const message = createNotificationMessage(row, dependencies.appUrl);
      const result = await dependencies.sender.send(message, row.idempotencyKey);
      const persisted = await markNotificationSent(dependencies.db, row, result.providerMessageId, now);
      if (!persisted) {
        summary.lostClaims += 1;
        return;
      }
      summary.sent += 1;
      dependencies.log?.({
        event: "notification.sent",
        notificationId: row.id,
        ...(row.incidentId ? { incidentId: row.incidentId } : {}),
        ...(row.monitorId ? { monitorId: row.monitorId } : {}),
        ...(row.dependencyId ? { dependencyId: row.dependencyId } : {}),
        attemptCount: row.attemptCount,
      });
    } catch (error) {
      const failure = safeFailure(error);
      const dead = !failure.retryable || row.attemptCount >= MAX_DELIVERY_ATTEMPTS;
      const persisted = await markNotificationFailed(dependencies.db, row, {
        dead,
        nextAttemptAt: retryAt(now, row.attemptCount),
        errorCode: failure.code,
        now,
      });
      if (!persisted) {
        summary.lostClaims += 1;
        return;
      }
      if (dead) summary.dead += 1;
      else summary.failed += 1;
      dependencies.log?.({
        event: "notification.failed",
        notificationId: row.id,
        ...(row.incidentId ? { incidentId: row.incidentId } : {}),
        ...(row.monitorId ? { monitorId: row.monitorId } : {}),
        ...(row.dependencyId ? { dependencyId: row.dependencyId } : {}),
        attemptCount: row.attemptCount,
        errorCode: failure.code,
      });
    }
  });

  return summary;
}
