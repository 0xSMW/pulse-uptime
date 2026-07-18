export type IncidentFilter = "all" | "ongoing" | "resolved";

export type NotificationState = "sent" | "retrying" | "dead" | "none";

export interface IncidentSummary {
  id: string;
  monitorId: string;
  monitorName: string;
  openedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  openingFailure: string;
  status: string | null;
  notificationSummary: {
    state: NotificationState;
    sentCount: number;
  };
}

export type IncidentEventType =
  | "first_failure"
  | "failure_confirmed"
  | "outage_queued"
  | "outage_sent"
  | "first_success"
  | "recovery_confirmed"
  | "recovery_queued"
  | "recovery_sent";

export interface IncidentEvent {
  type: IncidentEventType;
  at: string;
}

export interface IncidentDetail extends IncidentSummary {
  events: IncidentEvent[];
}
