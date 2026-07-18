import Link from "next/link";

import { StatusDot, stateLabels, type MonitorState } from "@/components/monitors/status-dot";
import { TimelineBar, type TimelineBucket } from "@/components/monitors/timeline-bar";
import { formatDuration, formatUptimeTable } from "@/lib/reporting/format";

import { OverallBanner } from "./overall-banner";

export type PublicStatusData = {
  pageName: string;
  lastUpdatedAt: string;
  overallState: "operational" | "investigating" | "outage" | "empty";
  currentIncidents: Array<{
    id: string;
    monitorName: string;
    openedAt: string;
    elapsedSeconds: number;
    cause: string;
  }>;
  groups: Array<{
    name: string;
    slug: string;
    monitors: Array<{
      id: string;
      name: string;
      state: MonitorState;
      uptime90d: number | null;
      timeline: TimelineBucket[];
    }>;
  }>;
  recentIncidents: Array<{
    id: string;
    monitorName: string;
    openedAt: string;
    durationSeconds: number;
  }>;
};

function formatUtcTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function formatUpdatedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last updated unavailable";
  return `Last updated ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })} UTC`;
}

function StatusCard({ data, groupView }: { data: PublicStatusData; groupView: boolean }) {
  if (data.groups.length === 0) {
    return (
      <section
        className="rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]"
        aria-labelledby="systems-heading"
      >
        <h2 id="systems-heading" className="text-sm font-semibold">
          Systems
        </h2>
        <div className="mt-4 flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
          <StatusDot state="PENDING" aria-hidden />
          <span>No public monitors in this group</span>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6" aria-label="System availability">
      {data.groups.map((group) => (
        <section
          key={group.slug}
          className="overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
          aria-labelledby={`group-${group.slug}`}
        >
          <div className="flex items-center justify-between px-6 pb-2 pt-5">
            <h2 id={`group-${group.slug}`} className="text-sm font-semibold">
              {group.name}
            </h2>
            {!groupView ? (
              <Link
                href={`/status/${group.slug}`}
                className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline"
                aria-label={`View ${group.name} status`}
              >
                View Group
              </Link>
            ) : null}
          </div>
          <div>
            {group.monitors.map((monitor) => (
              <div
                key={monitor.id}
                className="grid gap-3 border-t border-[var(--border)] px-6 py-4 sm:grid-cols-[minmax(130px,0.8fr)_minmax(210px,1.4fr)_72px] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot state={monitor.state} aria-hidden />
                  <span className="truncate text-[13px] font-medium">{monitor.name}</span>
                  <span className="sr-only">{stateLabels[monitor.state]}</span>
                </div>
                <TimelineBar
                  buckets={monitor.timeline}
                  label={`${monitor.name}, 90-day availability`}
                  className="order-3 sm:order-none"
                />
                <span className="font-data text-right text-[13px]">
                  {formatUptimeTable(monitor.uptime90d)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function StatusPageContent({
  data,
  groupView = false,
}: {
  data: PublicStatusData;
  groupView?: boolean;
}) {
  const groupName = groupView ? data.groups[0]?.name : undefined;

  return (
    <main className="mx-auto w-full max-w-[720px] px-4 pb-16 pt-12 sm:px-6">
      {groupView ? (
        <Link
          href="/status"
          className="mb-5 inline-flex text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline"
        >
          ← All Systems
        </Link>
      ) : null}

      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold tracking-[-0.32px]">{data.pageName}</h1>
          {groupName ? <p className="mt-1 text-[13px] text-[var(--fg-muted)]">{groupName}</p> : null}
        </div>
        <time dateTime={data.lastUpdatedAt} className="font-data text-xs text-[var(--fg-faint)]">
          {formatUpdatedTime(data.lastUpdatedAt)}
        </time>
      </header>

      <OverallBanner state={data.overallState} />

      {data.currentIncidents.length > 0 ? (
        <section className="mt-6 space-y-3" aria-labelledby="current-incidents-heading">
          <h2 id="current-incidents-heading" className="sr-only">
            Current Incidents
          </h2>
          {data.currentIncidents.map((incident) => (
            <article
              key={incident.id}
              className="rounded-xl border border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)] p-5"
            >
              <div className="flex items-center gap-2">
                <StatusDot state="DOWN" aria-hidden />
                <h3 className="text-sm font-semibold">{incident.monitorName}</h3>
              </div>
              <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
                Ongoing since <span className="font-data">{formatUtcTimestamp(incident.openedAt)} UTC</span>
                {" · "}
                <span className="font-data">{formatDuration(incident.elapsedSeconds)}</span> elapsed
              </p>
              <p className="font-data mt-2 break-words text-[13px] text-[var(--down-text)]">
                {incident.cause || "Availability check failed"}
              </p>
            </article>
          ))}
        </section>
      ) : null}

      <div className="mt-6">
        <StatusCard data={data} groupView={groupView} />
      </div>

      <section
        className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
        aria-labelledby="recent-incidents-heading"
      >
        <h2 id="recent-incidents-heading" className="px-6 py-4 text-sm font-semibold">
          Recent Incidents
        </h2>
        {data.recentIncidents.length > 0 ? (
          <ul className="divide-y divide-[var(--border)]" role="list">
            {data.recentIncidents.map((incident) => (
              <li
                key={incident.id}
                className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
              >
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  <StatusDot state="PENDING" aria-hidden />
                  <span className="truncate">{incident.monitorName}</span>
                  <span className="sr-only">Resolved</span>
                </span>
                <time
                  dateTime={incident.openedAt}
                  className="font-data text-[var(--fg-muted)]"
                >
                  {formatUtcTimestamp(incident.openedAt)} UTC
                </time>
                <span className="font-data sm:min-w-16 sm:text-right">
                  {formatDuration(incident.durationSeconds)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex items-center gap-2 border-t border-[var(--border)] px-6 py-5 text-[13px] text-[var(--fg-muted)]">
            <StatusDot state="UP" aria-hidden />
            <span>No recent incidents</span>
          </div>
        )}
      </section>
    </main>
  );
}
