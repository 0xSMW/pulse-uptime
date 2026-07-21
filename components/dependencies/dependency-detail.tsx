"use client"

import { ArrowLeft, ExternalLink } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  DependencyFidelityBadge,
  DependencyStatusBadge,
} from "@/components/dependencies/dependency-status"
import { DependencyTimeline } from "@/components/dependencies/dependency-timeline"
import { apiRequest, messageForError } from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { DependencyDetail as DependencyDetailData } from "@/lib/dependencies/queries"

function formatTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(value))
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--fg-muted)] text-xs">{label}</dt>
      <dd className="mt-1 font-data text-[13px]">{value}</dd>
    </div>
  )
}

function RemoveDependencyDialog({
  dependency,
  open,
  onOpenChange,
}: {
  dependency: DependencyDetailData
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    if (open && !dialog.open) {
      dialog.showModal()
    }
    if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  async function remove() {
    setBusy(true)
    setError("")
    try {
      await apiRequest(
        `/api/v1/dependencies/${encodeURIComponent(dependency.id)}`,
        { method: "DELETE" },
        true
      )
      router.push("/")
      router.refresh()
    } catch (cause) {
      setError(messageForError(cause))
      setBusy(false)
    }
  }

  return (
    <dialog
      aria-labelledby="remove-dependency-title"
      className="fixed inset-0 z-50 m-auto w-[min(420px,calc(100vw-32px))] rounded-xl border border-[var(--border-strong)] bg-[var(--bg)] p-6 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) {
          onOpenChange(false)
        }
      }}
      onClose={() => onOpenChange(false)}
      ref={dialogRef}
    >
      <h2 className="font-semibold text-base" id="remove-dependency-title">
        Remove Dependency
      </h2>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        Stops provider status polling for {dependency.name}
      </p>
      {error ? (
        <p className="mt-3 text-[13px] text-[var(--down-text)]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          disabled={busy}
          onClick={() => onOpenChange(false)}
          type="button"
          variant="secondary"
        >
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => void remove()}
          type="button"
          variant="error"
        >
          {busy ? "Removing…" : "Remove Dependency"}
        </Button>
      </div>
    </dialog>
  )
}

export function DependencyDetail({
  dependency,
}: {
  dependency: DependencyDetailData
}) {
  const router = useRouter()
  const { resolvedTimeZone } = useTimezone()
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    dependency.notificationsEnabled
  )
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleError, setToggleError] = useState("")
  const [removeOpen, setRemoveOpen] = useState(false)

  const activeIncident =
    dependency.incidents.find((incident) => incident.resolvedAt === null) ??
    null

  async function toggleNotifications(next: boolean) {
    setToggleBusy(true)
    setToggleError("")
    setNotificationsEnabled(next)
    try {
      await apiRequest(
        `/api/v1/dependencies/${encodeURIComponent(dependency.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ notificationsEnabled: next }),
        },
        true
      )
      router.refresh()
    } catch (error) {
      setNotificationsEnabled(!next)
      setToggleError(messageForError(error))
    } finally {
      setToggleBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
          href="/"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Overview
        </Link>
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-semibold text-xl tracking-[-0.02em]">
                {dependency.name}
              </h1>
              <DependencyStatusBadge
                pending={dependency.pendingFirstPoll}
                state={dependency.state}
              />
              <DependencyFidelityBadge fidelity={dependency.fidelity} />
              {dependency.pendingFirstPoll ? (
                <span className="text-[var(--fg-muted)] text-xs">
                  Awaiting first check
                </span>
              ) : null}
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-[var(--fg-muted)]">
              <span>{dependency.provider}</span>
              <span className="rounded bg-[var(--chip-bg)] px-1.5 py-0.5 font-medium text-[11px] text-[var(--fg)]">
                Provider reported
              </span>
            </div>
          </div>
          <Button
            onClick={() => setRemoveOpen(true)}
            size="sm"
            variant="error-outline"
          >
            Remove Dependency
          </Button>
        </div>
      </header>

      {activeIncident ? (
        <Card>
          <CardHeader>
            <CardTitle>{activeIncident.title}</CardTitle>
            <p className="text-[var(--fg-muted)] text-xs">
              Started{" "}
              {formatTimestamp(activeIncident.startedAt, resolvedTimeZone)}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {activeIncident.updates.length ? (
              activeIncident.updates.map((update) => (
                <div
                  className="border-[var(--border)] border-t pt-3 first:border-t-0 first:pt-0"
                  key={update.createdAt}
                >
                  <p className="text-[13px]">{update.bodyText}</p>
                  <p className="mt-1 font-data text-[var(--fg-faint)] text-xs">
                    {formatTimestamp(update.createdAt, resolvedTimeZone)}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-[var(--fg-muted)]">
                No updates yet
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>24h Timeline</CardTitle>
            <p className="text-[var(--fg-muted)] text-xs">Provider reported</p>
          </CardHeader>
          <CardContent>
            <DependencyTimeline
              bucketMs={3_600_000}
              buckets={dependency.timeline24h}
              height={32}
              label="24 hour provider timeline"
              timeZone={resolvedTimeZone}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>7 Day Timeline</CardTitle>
            <p className="text-[var(--fg-muted)] text-xs">Provider reported</p>
          </CardHeader>
          <CardContent>
            <DependencyTimeline
              bucketMs={86_400_000}
              buckets={dependency.timeline7d}
              height={32}
              label="7 day provider timeline"
              timeZone={resolvedTimeZone}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <DetailField label="Component" value={dependency.name} />
            {dependency.componentLabel ? (
              <DetailField label="Region" value={dependency.componentLabel} />
            ) : null}
            <DetailField
              label="Last Successful Feed Check"
              value={
                dependency.lastSuccessfulPollAt
                  ? formatTimestamp(
                      dependency.lastSuccessfulPollAt,
                      resolvedTimeZone
                    )
                  : "Never"
              }
            />
          </dl>
          {dependency.sourceScopeNote ? (
            <p className="mt-4 text-[var(--fg-muted)] text-xs">
              {dependency.sourceScopeNote}
            </p>
          ) : null}
          <a
            className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg)] transition-opacity duration-150 hover:opacity-70"
            href={dependency.canonicalUrl}
            rel="noreferrer"
            target="_blank"
          >
            View Provider Status
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center justify-between gap-4 font-medium text-[13px]">
            Notify on provider incidents
            <input
              checked={notificationsEnabled}
              className="size-4 accent-[var(--fg)]"
              disabled={toggleBusy}
              onChange={(event) =>
                void toggleNotifications(event.target.checked)
              }
              type="checkbox"
            />
          </label>
          {toggleError ? (
            <p className="mt-2 text-[var(--down-text)] text-xs" role="alert">
              {toggleError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <RemoveDependencyDialog
        dependency={dependency}
        onOpenChange={setRemoveOpen}
        open={removeOpen}
      />
    </div>
  )
}
