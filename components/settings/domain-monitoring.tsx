"use client"

import { useState } from "react"

import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
} from "@/components/settings/settings-api"
import { CardHeading, SettingsRow } from "@/components/settings/settings-row"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export type DomainMonitoringState =
  | "NOT_CONFIGURED"
  | "CONNECTED"
  | "NEEDS_ATTENTION"

export type DomainMonitoringWebhookStatus =
  | "NOT_CONFIGURED"
  | "ACTIVE"
  | "FAILING"

export interface DomainMonitoringData {
  state: DomainMonitoringState
  coveredDomainCount: number
  lastSuccessAt: string | null
  webhookStatus: DomainMonitoringWebhookStatus
  expiryAlertsEnabled: boolean
}

const stateLabels: Record<DomainMonitoringState, string> = {
  NOT_CONFIGURED: "Not configured",
  CONNECTED: "Connected",
  NEEDS_ATTENTION: "Needs attention",
}

const stateStyles: Record<DomainMonitoringState, string> = {
  NOT_CONFIGURED: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
  CONNECTED: "bg-[var(--up-bg)] text-[var(--up-text)]",
  NEEDS_ATTENTION: "bg-[var(--down-bg)] text-[var(--down-text)]",
}

const webhookLabels: Record<DomainMonitoringWebhookStatus, string> = {
  NOT_CONFIGURED: "Not configured",
  ACTIVE: "Active",
  FAILING: "Needs attention",
}

export function formatDomainMonitoringSuccess(value: string | null): string {
  if (!value) {
    return "Never"
  }
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return "Unavailable"
  }
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    hour12: false,
  })
    .format(date)
    .replace(",", "")
    .concat(" UTC")
}

function stateMessage(state: DomainMonitoringState): string | null {
  if (state === "NOT_CONFIGURED") {
    return "Connect Porkbun to enable expiry alerts"
  }
  if (state === "NEEDS_ATTENTION") {
    return "Reconnect Porkbun to resume updates"
  }
  return null
}

export function DomainMonitoringCard({ data }: { data: DomainMonitoringData }) {
  const [currentData, setCurrentData] = useState(data)
  const [busyAction, setBusyAction] = useState<
    "check" | "enable" | "disable" | "test" | "expiry" | null
  >(null)
  const [error, setError] = useState("")
  const toggleDisabled =
    busyAction !== null ||
    (!currentData.expiryAlertsEnabled && currentData.state !== "CONNECTED")

  async function performAction(
    action: Exclude<typeof busyAction, "expiry" | null>,
    url: string,
    body: Record<string, string>
  ) {
    setBusyAction(action)
    setError("")
    try {
      const response = await apiRequest<ApiEnvelope<DomainMonitoringData>>(
        url,
        { method: "POST", body: JSON.stringify(body) },
        { mutation: true }
      )
      setCurrentData(response.data)
    } catch (requestError) {
      setError(messageForError(requestError))
    } finally {
      setBusyAction(null)
    }
  }

  async function toggleExpiryAlerts() {
    const previousData = currentData
    const next = !currentData.expiryAlertsEnabled
    setCurrentData({ ...currentData, expiryAlertsEnabled: next })
    setBusyAction("expiry")
    setError("")
    try {
      const response = await apiRequest<ApiEnvelope<DomainMonitoringData>>(
        "/api/v1/domain-monitoring/settings",
        {
          method: "PATCH",
          body: JSON.stringify({ expiryAlertsEnabled: next }),
        },
        { mutation: true }
      )
      setCurrentData(response.data)
    } catch (requestError) {
      setCurrentData(previousData)
      setError(messageForError(requestError))
    } finally {
      setBusyAction(null)
    }
  }

  const message = stateMessage(currentData.state)
  const domainLabel = `${currentData.coveredDomainCount} ${currentData.coveredDomainCount === 1 ? "domain" : "domains"}`
  const webhookActions =
    currentData.state === "CONNECTED" &&
    currentData.webhookStatus === "NOT_CONFIGURED" ? (
      <Button
        disabled={busyAction !== null}
        onClick={() =>
          void performAction("enable", "/api/v1/domain-monitoring/webhook", {
            action: "enable",
          })
        }
        variant="secondary"
      >
        {busyAction === "enable" ? "Enabling…" : "Enable webhook"}
      </Button>
    ) : currentData.webhookStatus === "ACTIVE" ? (
      <>
        <Button
          disabled={busyAction !== null}
          onClick={() =>
            void performAction("test", "/api/v1/domain-monitoring/webhook", {
              action: "test",
            })
          }
          variant="secondary"
        >
          {busyAction === "test" ? "Sending…" : "Send test"}
        </Button>
        <Button
          disabled={busyAction !== null}
          onClick={() =>
            void performAction("disable", "/api/v1/domain-monitoring/webhook", {
              action: "disable",
            })
          }
          variant="tertiary"
        >
          {busyAction === "disable" ? "Disabling…" : "Disable"}
        </Button>
      </>
    ) : currentData.webhookStatus === "FAILING" ? (
      <>
        <Button
          disabled={busyAction !== null}
          onClick={() =>
            void performAction("enable", "/api/v1/domain-monitoring/webhook", {
              action: "enable",
            })
          }
          variant="secondary"
        >
          {busyAction === "enable" ? "Reconnecting…" : "Reconnect webhook"}
        </Button>
        <Button
          disabled={busyAction !== null}
          onClick={() =>
            void performAction("test", "/api/v1/domain-monitoring/webhook", {
              action: "test",
            })
          }
          variant="tertiary"
        >
          {busyAction === "test" ? "Sending…" : "Send test"}
        </Button>
      </>
    ) : null

  return (
    <Card aria-busy={busyAction !== null} className="overflow-hidden">
      <CardHeading
        action={
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 font-medium text-xs",
              stateStyles[currentData.state]
            )}
          >
            {stateLabels[currentData.state]}
          </span>
        }
        title="Domain monitoring"
      />
      <div className="px-6 pt-3 pb-4 text-[13px] text-[var(--fg-muted)]">
        Registration uses Porkbun. Certificate checks use direct TLS probes.
      </div>
      <div className="flex flex-wrap gap-2 px-6 pb-4">
        <Button
          disabled={busyAction !== null}
          onClick={() =>
            void performAction("check", "/api/v1/domain-monitoring/check", {})
          }
          variant="secondary"
        >
          {busyAction === "check" ? "Checking…" : "Check connection"}
        </Button>
        {webhookActions}
      </div>
      <dl className="grid border-[var(--border)] border-t sm:grid-cols-3">
        <div className="border-[var(--border)] border-b px-6 py-4 sm:border-r sm:border-b-0">
          <dt className="text-[var(--fg-muted)] text-xs">Covered domains</dt>
          <dd className="mt-1 font-data text-[13px]">{domainLabel}</dd>
        </div>
        <div className="border-[var(--border)] border-b px-6 py-4 sm:border-r sm:border-b-0">
          <dt className="text-[var(--fg-muted)] text-xs">Last success</dt>
          <dd className="mt-1 font-data text-[13px]">
            {formatDomainMonitoringSuccess(currentData.lastSuccessAt)}
          </dd>
        </div>
        <div className="px-6 py-4">
          <dt className="text-[var(--fg-muted)] text-xs">Webhook</dt>
          <dd className="mt-1 font-data text-[13px]">
            {webhookLabels[currentData.webhookStatus]}
          </dd>
        </div>
      </dl>
      <SettingsRow
        description={message ?? "Email alerts before registration expires"}
        label="Expiry alerts"
      >
        <button
          aria-checked={currentData.expiryAlertsEnabled}
          aria-label="Toggle expiry alerts"
          className={cn(
            "relative h-5 w-9 rounded-full border border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-50",
            currentData.expiryAlertsEnabled
              ? "bg-[var(--fg)]"
              : "bg-[var(--chip-bg)]"
          )}
          disabled={toggleDisabled}
          onClick={toggleExpiryAlerts}
          role="switch"
          type="button"
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-[3px] size-3 rounded-full",
              currentData.expiryAlertsEnabled
                ? "left-[19px] bg-[var(--bg)]"
                : "left-[3px] bg-[var(--fg-muted)]"
            )}
          />
        </button>
      </SettingsRow>
      {error ? (
        <p
          className="border-[var(--border)] border-t px-6 py-3 text-[13px] text-[var(--down-text)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </Card>
  )
}
