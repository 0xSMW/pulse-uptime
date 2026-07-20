import { gte } from "drizzle-orm";

import { incidents, monitorState } from "@/lib/db/schema";

export type NotificationDeliveryStatus = "pending" | "sending" | "sent" | "failed" | "dead";

// First-run gate for every per-monitor incident surface. An incident opened
// before its monitor activated is a setup-phase failure, not real downtime, so
// joining monitor_state and requiring openedAt at or after activatedAt drops it.
// A null activatedAt fails the comparison, so a never-activated monitor surfaces
// no incidents. A genuine ongoing incident is unaffected: the backfill sets
// activatedAt at or before its openedAt.
export const activationGate = gte(incidents.openedAt, monitorState.activatedAt);

export function durationSeconds(openedAt: Date, resolvedAt: Date | null, now = new Date()): number {
  return Math.max(0, Math.floor(((resolvedAt ?? now).getTime() - openedAt.getTime()) / 1_000));
}

export function failureLabel(errorCode: string | null, statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  return errorCode ?? "Unknown failure";
}

// Single source of truth for the sent/retrying/dead/none precedence, shared by
// the SQL aggregate path and the per-row path.
export function summarizeNotificationAggregate(aggregate: {
  sentCount: number;
  anyDead: boolean;
  anyUnsent: boolean;
}) {
  const state = aggregate.anyDead
    ? "dead" as const
    : aggregate.anyUnsent
      ? "retrying" as const
      : aggregate.sentCount > 0
        ? "sent" as const
        : "none" as const;
  return { state, sentCount: aggregate.sentCount };
}

export function summarizeNotificationRows(rows: { status: NotificationDeliveryStatus }[]) {
  return summarizeNotificationAggregate({
    sentCount: rows.filter((row) => row.status === "sent").length,
    anyDead: rows.some((row) => row.status === "dead"),
    anyUnsent: rows.some((row) => row.status !== "sent"),
  });
}
