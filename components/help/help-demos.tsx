"use client"

import { useState } from "react"

import { IncidentEventTrail } from "@/components/incidents/incident-event-trail"
import { IncidentStatus } from "@/components/incidents/incident-status"
import { NotificationSummary } from "@/components/incidents/notification-summary"
import type { IncidentEvent } from "@/components/incidents/types"
import { StatusBadge } from "@/components/monitors/status-badge"
import { type MonitorState, StatusDot } from "@/components/monitors/status-dot"
import {
  TimelineBar,
  type TimelineBucket,
} from "@/components/monitors/timeline-bar"
import { OverallBanner } from "@/components/status-page/overall-banner"
import { CodeBlock } from "@/components/ui/code-block"
import type { HelpDemoKey } from "@/lib/help/registry"
import { cn } from "@/lib/utils"

// Fixture data only — no production monitors, emails, tokens, or incidents.

const badgeStates: MonitorState[] = [
  "PENDING",
  "UP",
  "VERIFYING_DOWN",
  "DOWN",
  "PAUSED",
]

function timelineFixture(): TimelineBucket[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const state: TimelineBucket["state"] =
      hour === 9
        ? "down"
        : hour === 10
          ? "verifying"
          : hour >= 14 && hour <= 16
            ? "no-data"
            : "up"
    return {
      state,
      label: `${String(hour).padStart(2, "0")}:00`,
      checks: state === "no-data" ? 0 : 12,
      failures: state === "down" ? 9 : state === "verifying" ? 2 : 0,
      downtimeSeconds: state === "down" ? 2700 : undefined,
    }
  })
}

const incidentEvents: IncidentEvent[] = [
  { type: "first_failure", at: "2026-01-12T09:24:00Z" },
  { type: "failure_confirmed", at: "2026-01-12T09:26:00Z" },
  { type: "outage_sent", at: "2026-01-12T09:27:00Z" },
  { type: "first_success", at: "2026-01-12T09:41:00Z" },
  { type: "recovery_confirmed", at: "2026-01-12T09:43:00Z" },
  { type: "recovery_sent", at: "2026-01-12T09:44:00Z" },
]

function DemoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 text-[13px] first:pt-0 last:pb-0 sm:grid-cols-[160px_1fr] sm:gap-6">
      <dt className="text-[var(--fg-muted)] text-xs sm:text-[13px]">{label}</dt>
      <dd className="font-data text-[13px]">{children}</dd>
    </div>
  )
}

function MonitorRowDemo() {
  return (
    <div className="rounded-[8px] border border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <StatusDot aria-hidden state="UP" />
        <div className="min-w-0">
          <p className="font-medium text-[13px]">Marketing site</p>
          <p className="truncate font-data text-[var(--fg-faint)] text-xs">
            https://superposition.app
          </p>
        </div>
        <span className="ml-auto font-data text-[var(--fg-muted)] text-xs">
          GET · 1m · 10s timeout
        </span>
        <StatusBadge state="UP" />
      </div>
    </div>
  )
}

function MonitorStatesDemo() {
  return (
    <ul className="flex flex-wrap items-center gap-2.5">
      {badgeStates.map((state) => (
        <li key={state}>
          <StatusBadge state={state} />
        </li>
      ))}
    </ul>
  )
}

function CheckSettingsDemo() {
  return (
    <dl className="divide-y divide-[var(--border)]">
      <DemoRow label="Method and URL">
        GET https://inference.superposition.app/health
      </DemoRow>
      <DemoRow label="Interval">Every 1 minute</DemoRow>
      <DemoRow label="Timeout">10 seconds</DemoRow>
      <DemoRow label="Expected status">200–299</DemoRow>
      <DemoRow label="Failure threshold">3 consecutive failures</DemoRow>
      <DemoRow label="Recovery threshold">2 consecutive successes</DemoRow>
    </dl>
  )
}

const timelineLegend: Array<{ label: string; className: string }> = [
  { label: "Success", className: "bg-[var(--up)]" },
  { label: "Failure", className: "bg-[var(--down)]" },
  { label: "Verifying", className: "bg-[var(--verifying)]" },
  {
    label: "Unknown",
    className: "bg-[var(--chip-bg)] border border-[var(--border-strong)]",
  },
]

function TimelineDemo() {
  return (
    <div className="space-y-3">
      <TimelineBar
        buckets={timelineFixture()}
        height={24}
        label="Availability over 24 hours"
      />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--fg-muted)] text-xs">
        {timelineLegend.map((item) => (
          <li className="flex items-center gap-1.5" key={item.label}>
            <span
              aria-hidden="true"
              className={cn("size-2 rounded-[1.5px]", item.className)}
            />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function IncidentDemo() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-[8px] border border-[var(--border)] px-4 py-3">
        <IncidentStatus ongoing />
        <div className="min-w-0">
          <p className="font-medium text-[13px]">Inference</p>
          <p className="truncate font-data text-[var(--fg-muted)] text-xs">
            HTTP 529 from https://inference.superposition.app/health
          </p>
        </div>
        <span className="ml-auto font-data text-[var(--fg-muted)] text-xs">
          19m
        </span>
      </div>
      <IncidentEventTrail events={incidentEvents} />
    </div>
  )
}

function AlertsDemo() {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 font-medium text-[13px]">Default Recipients</p>
        <div className="rounded-[6px] border border-[var(--border-strong)] bg-[var(--chip-bg)] px-3 py-2 font-data text-[13px] text-[var(--fg-muted)] leading-6">
          codex@superposition.app
          <br />
          alerts@superposition.app
        </div>
      </div>
      <dl className="divide-y divide-[var(--border)]">
        <DemoRow label="Delivered">
          <NotificationSummary summary={{ state: "sent", sentCount: 2 }} />
        </DemoRow>
        <DemoRow label="Retrying">
          <NotificationSummary summary={{ state: "retrying", sentCount: 0 }} />
        </DemoRow>
        <DemoRow label="Failed permanently">
          <NotificationSummary summary={{ state: "dead", sentCount: 0 }} />
        </DemoRow>
      </dl>
    </div>
  )
}

function StatusPageDemo() {
  return (
    <div className="space-y-4">
      <OverallBanner state="operational" />
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="flex items-center gap-2 font-medium">
            <StatusDot aria-hidden state="UP" />
            Marketing site
          </span>
          <span className="font-data text-[var(--fg-muted)] text-xs">
            99.98%
          </span>
        </div>
        <TimelineBar
          buckets={timelineFixture()}
          height={24}
          label="Marketing site availability over 24 hours"
        />
      </div>
    </div>
  )
}

function TokensDemo() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[8px] border border-[var(--border)] px-4 py-3">
        <div>
          <p className="font-medium text-[13px]">deploy-agent</p>
          <p className="text-[var(--fg-faint)] text-xs">Agent token</p>
        </div>
        <span className="font-data text-[var(--fg-muted)] text-xs">
          pulse_live_····
        </span>
        <div className="flex flex-wrap gap-1">
          {["monitors:read", "incidents:read"].map((scope) => (
            <span
              className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px]"
              key={scope}
            >
              {scope}
            </span>
          ))}
        </div>
        <span className="ml-auto font-data text-[var(--fg-muted)] text-xs">
          Expires Jan 12, 2027
        </span>
      </div>
      <CodeBlock
        code={"pulsectl monitor list --output json"}
        copyLabel="Copy command"
        language="shell"
      />
    </div>
  )
}

function DatabaseHealthDemo() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="font-data font-medium text-[15px]">118 MB of 500 MB</p>
        <div
          aria-label="Example database storage used"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={24}
          aria-valuetext="24% used"
          className="h-2 overflow-hidden rounded-full bg-[var(--chip-bg)]"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-[var(--fg-muted)]"
            style={{ width: "24%" }}
          />
        </div>
      </div>
      <dl className="divide-y divide-[var(--border)]">
        <DemoRow label="Recent checks">
          Kept 2 days · Oldest 26 hours ago
        </DemoRow>
        <DemoRow label="Daily rollups">
          Kept 730 days · Oldest 31 days ago
        </DemoRow>
        <DemoRow label="Governor">
          Full detail — keeping full configured detail
        </DemoRow>
      </dl>
    </div>
  )
}

function TestMonitorDemo() {
  const [checked, setChecked] = useState(false)

  return (
    <div className="space-y-3">
      <button
        className="inline-flex h-8 items-center rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 font-medium text-sm hover:border-[var(--border-hover)]"
        onClick={() => setChecked(true)}
        type="button"
      >
        Test Monitor
      </button>
      <p
        aria-live="polite"
        className="font-data text-[13px] text-[var(--fg-muted)]"
      >
        {checked
          ? "200 OK · 184 ms · just now"
          : "Run a simulated check to see its result"}
      </p>
    </div>
  )
}

function PauseToggleDemo() {
  const [enabled, setEnabled] = useState(true)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        aria-checked={enabled}
        aria-label={`${enabled ? "Pause" : "Resume"} example monitor`}
        className={cn(
          "relative h-5 w-9 rounded-full border border-[var(--border-strong)]",
          enabled ? "bg-[var(--fg)]" : "bg-[var(--chip-bg)]"
        )}
        onClick={() => setEnabled((value) => !value)}
        role="switch"
        type="button"
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-[3px] size-3 rounded-full",
            enabled
              ? "left-[19px] bg-[var(--bg)]"
              : "left-[3px] bg-[var(--fg-muted)]"
          )}
        />
      </button>
      <StatusBadge state={enabled ? "UP" : "PAUSED"} />
      <span className="text-[13px] text-[var(--fg-muted)]">
        {enabled ? "Checks run on schedule" : "No checks run, no alerts sent"}
      </span>
    </div>
  )
}

function EmailTestDemo() {
  return (
    <dl className="divide-y divide-[var(--border)]">
      <DemoRow label="Sender">status@superposition.app via Resend</DemoRow>
      <DemoRow label="Last test">Test sent to codex@superposition.app</DemoRow>
    </dl>
  )
}

function CliLinkDemo() {
  return (
    <CodeBlock
      code={
        "go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest\npulsectl me --server https://pulse.superposition.app"
      }
      copyLabel="Copy install commands"
      language="shell"
    />
  )
}

function AgentConnectDemo() {
  return (
    <CodeBlock
      code={
        "export PULSECTL_URL=https://pulse.superposition.app\nexport PULSECTL_TOKEN=pulse_live_...\npulsectl monitor list --output json"
      }
      copyLabel="Copy agent setup"
      language="shell"
    />
  )
}

export const helpDemos: Record<
  HelpDemoKey,
  { label: string; Demo: React.ComponentType }
> = {
  "monitor-row": {
    label: "A monitor row with name, URL, interval, and state",
    Demo: MonitorRowDemo,
  },
  "monitor-states": {
    label: "Badges for every monitor state",
    Demo: MonitorStatesDemo,
  },
  "check-settings": {
    label: "Check settings for one monitor",
    Demo: CheckSettingsDemo,
  },
  timeline: {
    label: "A timeline with success, failure, and Unknown coverage",
    Demo: TimelineDemo,
  },
  incident: {
    label: "An ongoing incident and its event trail",
    Demo: IncidentDemo,
  },
  alerts: { label: "Default recipients and delivery states", Demo: AlertsDemo },
  "status-page": {
    label: "Status banner and a monitor timeline",
    Demo: StatusPageDemo,
  },
  tokens: { label: "A scoped token and a pulsectl command", Demo: TokensDemo },
  "database-health": {
    label: "Storage, retention, and governor summary",
    Demo: DatabaseHealthDemo,
  },
  "test-monitor": {
    label: "A simulated immediate check",
    Demo: TestMonitorDemo,
  },
  "pause-toggle": {
    label: "The pause switch and its effect",
    Demo: PauseToggleDemo,
  },
  "email-test": {
    label: "Sender and test delivery summary",
    Demo: EmailTestDemo,
  },
  "cli-link": { label: "Install and link pulsectl", Demo: CliLinkDemo },
  "agent-connect": { label: "Agent environment setup", Demo: AgentConnectDemo },
}
