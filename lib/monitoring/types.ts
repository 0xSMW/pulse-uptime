import type { CheckErrorCode } from "@/lib/checker/types";
import type { monitorStates } from "@/lib/db/schema";

export type MonitorStateName = (typeof monitorStates)[number];

export type MonitorStateSnapshot = {
  monitorId: string;
  state: MonitorStateName;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  firstFailureAt: Date | null;
  firstSuccessAt: Date | null;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastErrorCode: string | null;
  activeIncidentId: string | null;
  version: number;
  updatedAt: Date;
};

export type CheckTransitionEvent = {
  type: "check";
  checkedAt: Date;
  successful: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorCode: CheckErrorCode | null;
  failureThreshold: number;
  recoveryThreshold: number;
};

export type LifecycleTransitionEvent = {
  type: "disable" | "archive" | "enable" | "restore";
  occurredAt: Date;
};

export type MonitorTransitionEvent = CheckTransitionEvent | LifecycleTransitionEvent;

export type IncidentIntent =
  | { type: "open"; openedAt: Date; firstFailureAt: Date }
  | { type: "resolve"; incidentId: string; resolvedAt: Date; firstSuccessAt: Date }
  | null;

export type StateTransition = {
  previousState: MonitorStateName;
  state: MonitorStateSnapshot;
  changed: boolean;
  incident: IncidentIntent;
};

export type ScheduledCheck = {
  monitorId: string;
  runId: string;
  scheduledAt: Date;
  checkedAt: Date;
  successful: boolean;
  statusCode: number | null;
  latencyMs: number;
  effectiveUrl: string | null;
  redirectCount: number;
  resolvedAddress: string | null;
  errorCode: CheckErrorCode | null;
  errorMessage: string | null;
  failureThreshold: number;
  recoveryThreshold: number;
  recipients: string[];
};

export type ProcessCheckResult =
  | { status: "duplicate"; monitorId: string; scheduledAt: Date }
  | {
      status: "processed";
      monitorId: string;
      previousState: MonitorStateName;
      state: MonitorStateName;
      incidentId: string | null;
      event: "incident.opened" | "incident.resolved" | null;
    };
