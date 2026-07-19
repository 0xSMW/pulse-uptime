import type { ReactNode } from "react";
import { DependencyIncidentEmail } from "@/emails/dependency-incident";
import { DependencyRecoveryEmail } from "@/emails/dependency-recovery";
import { OutageEmail } from "@/emails/outage";
import { RecoveryEmail } from "@/emails/recovery";
import { TestEmail } from "@/emails/test";
import { notificationPayloadSchema, type ClaimedNotification, type NotificationPayload } from "./types";

export interface NotificationMessage {
  to: string;
  subject: string;
  react: ReactNode;
}

export function incidentUrl(appUrl: string, incidentId: string): string {
  const base = new URL(appUrl);
  base.pathname = `/incidents/${encodeURIComponent(incidentId)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function assertPayloadType(
  row: ClaimedNotification,
  expected: NotificationPayload["type"],
): void {
  if (!row.payload || row.payload.type !== expected || row.eventType !== expected) {
    throw new InvalidNotificationPayloadError();
  }
}

export class InvalidNotificationPayloadError extends Error {
  readonly code = "INVALID_PAYLOAD";

  constructor() {
    super("Notification payload does not match its event");
    this.name = "InvalidNotificationPayloadError";
  }
}

export function createNotificationMessage(
  row: ClaimedNotification,
  appUrl: string,
): NotificationMessage {
  const parsed = notificationPayloadSchema.safeParse(row.payload);
  if (!parsed.success) throw new InvalidNotificationPayloadError();
  const payload = parsed.data;
  switch (row.eventType) {
    case "incident.opened": {
      assertPayloadType(row, "incident.opened");
      if (payload.type !== "incident.opened") throw new InvalidNotificationPayloadError();
      return {
        to: row.recipient,
        subject: `${payload.monitorName} is down`,
        react: (
          <OutageEmail
            monitorName={payload.monitorName}
            incidentUrl={incidentUrl(appUrl, payload.incidentId)}
            startedAt={payload.startedAt}
            cause={payload.cause}
          />
        ),
      };
    }
    case "incident.resolved": {
      assertPayloadType(row, "incident.resolved");
      if (payload.type !== "incident.resolved") throw new InvalidNotificationPayloadError();
      return {
        to: row.recipient,
        subject: `${payload.monitorName} recovered`,
        react: (
          <RecoveryEmail
            monitorName={payload.monitorName}
            incidentUrl={incidentUrl(appUrl, payload.incidentId)}
            recoveredAt={payload.recoveredAt}
            duration={payload.duration}
          />
        ),
      };
    }
    case "notification.test": {
      assertPayloadType(row, "notification.test");
      if (payload.type !== "notification.test") throw new InvalidNotificationPayloadError();
      return {
        to: row.recipient,
        subject: "Pulse notification test",
        react: <TestEmail installationName={payload.installationName} />,
      };
    }
    case "dependency.incident": {
      assertPayloadType(row, "dependency.incident");
      if (payload.type !== "dependency.incident") throw new InvalidNotificationPayloadError();
      return {
        to: row.recipient,
        subject: `${payload.dependencyName}: provider reported incident`,
        react: (
          <DependencyIncidentEmail
            dependencyName={payload.dependencyName}
            provider={payload.provider}
            incidentTitle={payload.incidentTitle}
            state={payload.state}
            canonicalUrl={payload.canonicalUrl}
            providerTimestamp={payload.providerTimestamp}
          />
        ),
      };
    }
    case "dependency.recovery": {
      assertPayloadType(row, "dependency.recovery");
      if (payload.type !== "dependency.recovery") throw new InvalidNotificationPayloadError();
      return {
        to: row.recipient,
        subject: `${payload.dependencyName}: provider incident resolved`,
        react: (
          <DependencyRecoveryEmail
            dependencyName={payload.dependencyName}
            provider={payload.provider}
            incidentTitle={payload.incidentTitle}
            state={payload.state}
            canonicalUrl={payload.canonicalUrl}
            providerTimestamp={payload.providerTimestamp}
          />
        ),
      };
    }
    default:
      throw new InvalidNotificationPayloadError();
  }
}
