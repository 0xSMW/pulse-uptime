"use client"

import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  IncidentTime,
  IncidentTimeRange,
} from "@/components/incidents/incident-time"
import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"
import type { AttributedIncidentExclusion } from "@/lib/incidents/exclusion-attribution"
import type { IncidentExclusionPreview } from "@/lib/incidents/exclusions"
import { formatUptimeDetail } from "@/lib/reporting/format"
import {
  formatDatetimeInput,
  parseDatetimeInput,
} from "@/lib/time/datetime-input"

function uptime(value: number | null): string {
  return value === null ? "No eligible checks" : formatUptimeDetail(value)
}

function failedChecks(count: number): string {
  return count === 1
    ? "1 failed check excluded"
    : `${count} failed checks excluded`
}

// The preview measures the last 24 hours only. Older failed checks still
// change historical uptime, so say so instead of implying no impact.
function olderImpact(preview: IncidentExclusionPreview): string | null {
  const affected = preview.affectedFailedChecks
  if (
    affected === 0 ||
    Date.parse(preview.startAt) >= Date.parse(preview.windowStart)
  ) {
    return null
  }
  const inWindow =
    preview.after.excludedFailedChecks - preview.before.excludedFailedChecks
  if (inWindow <= 0) {
    return "Outside the last 24 hours, so only historical uptime changes"
  }
  return inWindow < affected
    ? "Some are older than 24 hours, so historical uptime also changes"
    : null
}

type Resolved = { iso: string } | { error: string }

// A repeated wall time is accepted only when it matches the instant that
// filled the field. Otherwise the user picks an unambiguous minute.
function resolveInput(
  value: string,
  timeZone: string,
  seed: string,
  label: "Start" | "End"
): Resolved {
  const parsed = parseDatetimeInput(value, timeZone)
  if (parsed.status === "ok") {
    return { iso: parsed.iso }
  }
  if (parsed.status === "ambiguous") {
    // Fields hold whole minutes, so compare the seed at that precision.
    const seedTime = Math.floor(Date.parse(seed) / 60_000) * 60_000
    const match = [parsed.earlier, parsed.later].find(
      (candidate) => Date.parse(candidate) === seedTime
    )
    return match
      ? { iso: match }
      : { error: `${label} time repeats at a clock change` }
  }
  return parsed.status === "nonexistent"
    ? { error: `${label} time is skipped by a clock change` }
    : { error: `Enter a valid ${label.toLowerCase()} time` }
}

const fieldClass =
  "w-full min-w-0 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 text-[13px]"

function ExclusionDialog({
  incidentId,
  defaultStartAt,
  defaultEndAt,
  onClose,
  onSaved,
}: {
  incidentId: string
  defaultStartAt: string
  defaultEndAt: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const { resolvedTimeZone: timeZone } = useTimezone()
  // The range override and reason are user input, independent of server state.
  // The seeds keep the instants that filled the fields, because a repeated
  // wall time at a clock change cannot be traced back to one instant.
  const [range, setRange] = useState<{
    startAt: string
    endAt: string
    seedStartAt: string
    seedEndAt: string
  } | null>(null)
  const [reason, setReason] = useState("")
  const [submission, setSubmission] = useState({ busy: false, error: "" })
  const retry = useRef<{ body: string; key: string } | null>(null)
  const path = `/api/v1/incidents/${encodeURIComponent(incidentId)}/exclusions`
  const start = range
    ? resolveInput(range.startAt, timeZone, range.seedStartAt, "Start")
    : null
  const end = range
    ? resolveInput(range.endAt, timeZone, range.seedEndAt, "End")
    : null
  let rangeError = ""
  if (start && "error" in start) {
    rangeError = start.error
  } else if (end && "error" in end) {
    rangeError = end.error
  } else if (start && end && Date.parse(start.iso) >= Date.parse(end.iso)) {
    rangeError = "Choose an end after the start"
  }
  const body =
    start && end && "iso" in start && "iso" in end && !rangeError
      ? { startAt: start.iso, endAt: end.iso }
      : {}
  const {
    data: preview,
    error,
    isValidating,
    mutate,
  } = useSWR(
    rangeError ? null : [path, JSON.stringify(body)],
    async ([url, requestBody]: [string, string]) => {
      const response = await apiRequest<ApiEnvelope<IncidentExclusionPreview>>(
        `${url}/preview`,
        { method: "POST", body: requestBody }
      )
      return response.data
    },
    // The last confirmed preview stays visible while the next one loads.
    {
      shouldRetryOnError: false,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  const showPreview = Boolean(preview && !error && !rangeError)
  const older = preview && showPreview ? olderImpact(preview) : null
  const alert = error ? messageForError(error) : rangeError

  // Native dialog focus, Escape, and focus restoration are browser behavior.
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (
      !(preview && reason.trim()) ||
      error ||
      rangeError ||
      submission.busy ||
      isValidating
    ) {
      return
    }
    const requestBody = JSON.stringify({
      startAt: preview.startAt,
      endAt: preview.endAt,
      reason: reason.trim(),
      previewVersion: preview.previewVersion,
    })
    if (retry.current?.body !== requestBody) {
      retry.current = { body: requestBody, key: crypto.randomUUID() }
    }
    setSubmission({ busy: true, error: "" })
    try {
      await apiRequest(path, {
        method: "POST",
        body: requestBody,
        headers: { "Idempotency-Key": retry.current.key },
      })
      await onSaved()
      onClose()
    } catch (caught) {
      setSubmission({ busy: false, error: messageForError(caught) })
      // A changed preview must be reviewed before another submission.
      if ((caught as { status?: number }).status === 409) {
        await mutate()
      }
    }
  }

  return (
    <dialog
      aria-labelledby={titleId}
      className="fixed inset-0 z-[90] m-auto max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--bg)] p-6 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"
      onCancel={(event) => {
        event.preventDefault()
        if (!submission.busy) {
          onClose()
        }
      }}
      ref={dialog}
    >
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <div>
          <h2 className="font-semibold text-base" id={titleId}>
            Mark false alarm
          </h2>
          <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
            Exclude failed checks from downtime. Observed status and incident
            timing stay unchanged
          </p>
        </div>
        {preview && showPreview ? (
          <div className="space-y-3 text-[13px]">
            <p>Excluded interval</p>
            <p className="font-data text-[var(--fg-muted)]">
              <IncidentTimeRange
                endAt={preview.endAt}
                startAt={preview.startAt}
              />
            </p>
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            checked={range !== null}
            disabled={submission.busy}
            onChange={(event) => {
              if (!event.target.checked) {
                setRange(null)
                return
              }
              const seedStartAt = preview?.startAt ?? defaultStartAt
              const seedEndAt =
                preview?.endAt ??
                defaultEndAt ??
                new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString()
              setRange({
                startAt: formatDatetimeInput(seedStartAt, timeZone),
                endAt: formatDatetimeInput(seedEndAt, timeZone),
                seedStartAt,
                seedEndAt,
              })
            }}
            type="checkbox"
          />
          Choose a narrower interval
        </label>
        {range ? (
          <fieldset className="space-y-4" disabled={submission.busy}>
            <label className="block space-y-1.5">
              <span className="break-words text-[13px]">Start, {timeZone}</span>
              <input
                className={fieldClass}
                onChange={(event) =>
                  setRange({ ...range, startAt: event.target.value })
                }
                required
                step="60"
                type="datetime-local"
                value={range.startAt}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="break-words text-[13px]">End, {timeZone}</span>
              <input
                className={fieldClass}
                onChange={(event) =>
                  setRange({ ...range, endAt: event.target.value })
                }
                required
                step="60"
                type="datetime-local"
                value={range.endAt}
              />
            </label>
          </fieldset>
        ) : null}
        {/* The region stays mounted so updates are announced in place. */}
        <div
          aria-busy={isValidating}
          className={
            showPreview
              ? "space-y-2 rounded-lg border border-[var(--border)] p-4 text-[13px]"
              : "sr-only"
          }
          role="status"
        >
          {preview && showPreview ? (
            <>
              <p>{failedChecks(preview.affectedFailedChecks)}</p>
              <p>
                24-hour uptime: {uptime(preview.before.uptime)} →{" "}
                {uptime(preview.after.uptime)}
              </p>
              {older ? <p>{older}</p> : null}
            </>
          ) : null}
        </div>
        {alert ? (
          <p className="text-[13px] text-[var(--down-text)]" role="alert">
            {alert}
          </p>
        ) : null}
        <label className="block space-y-1.5">
          <span className="text-[13px]">Reason, private</span>
          <textarea
            className={fieldClass}
            disabled={submission.busy}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            required
            rows={3}
            value={reason}
          />
        </label>
        {submission.error ? (
          <p className="text-[13px] text-[var(--down-text)]" role="alert">
            {submission.error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={submission.busy}
            onClick={onClose}
            variant="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={
              !preview ||
              Boolean(error) ||
              Boolean(rangeError) ||
              !reason.trim() ||
              isValidating ||
              submission.busy
            }
            type="submit"
          >
            Exclude from downtime
          </Button>
        </div>
      </form>
    </dialog>
  )
}

export function IncidentExclusions({
  incidentId,
  monitorId,
  exclusions,
  canManageMonitors,
  defaultStartAt,
  defaultEndAt,
}: {
  incidentId: string
  monitorId: string
  exclusions: AttributedIncidentExclusion[]
  canManageMonitors: boolean
  defaultStartAt: string
  defaultEndAt: string | null
}) {
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [open, setOpen] = useState(false)
  // Undo is an in-flight user action and its error is not server state.
  const [undo, setUndo] = useState({ id: "", error: "" })
  const undoKeys = useRef(new Map<string, string>())

  async function refresh() {
    router.refresh()
    await mutate(
      (key) =>
        typeof key === "string" &&
        key.startsWith(`/api/v1/monitors/${encodeURIComponent(monitorId)}`)
    )
  }

  async function undoExclusion(id: string) {
    const key = undoKeys.current.get(id) ?? crypto.randomUUID()
    undoKeys.current.set(id, key)
    setUndo({ id, error: "" })
    try {
      await apiRequest(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/exclusions/${encodeURIComponent(id)}/undo`,
        {
          method: "POST",
          body: "{}",
          headers: { "Idempotency-Key": key },
        }
      )
      await refresh()
      setUndo({ id: "", error: "" })
    } catch (caught) {
      setUndo({ id: "", error: messageForError(caught) })
    }
  }

  if (!canManageMonitors && exclusions.length === 0) {
    return null
  }

  return (
    <section
      aria-label="Downtime exclusions"
      className="mb-6 space-y-6 rounded-xl border border-[var(--border-strong)] p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium text-sm">Downtime exclusions</h2>
        {canManageMonitors &&
        !exclusions.some((exclusion) => !exclusion.revertedAt) ? (
          <Button onClick={() => setOpen(true)} size="sm" variant="secondary">
            Mark false alarm
          </Button>
        ) : null}
      </div>
      {exclusions.map((exclusion) => (
        <article className="space-y-2 text-[13px]" key={exclusion.id}>
          <p className="font-medium">
            {exclusion.revertedAt ? "Exclusion undone" : "Excluded"}
          </p>
          <p className="font-data text-[var(--fg-muted)]">
            <IncidentTimeRange
              endAt={exclusion.endAt}
              startAt={exclusion.startAt}
            />
          </p>
          <p className="whitespace-pre-wrap break-words">{exclusion.reason}</p>
          <p className="break-words text-[var(--fg-muted)]">
            {exclusion.createdByLabel} ·{" "}
            <IncidentTime value={exclusion.createdAt} />
          </p>
          {exclusion.revertedAt ? (
            <p className="break-words text-[var(--fg-muted)]">
              Undone by {exclusion.revertedByLabel} ·{" "}
              <IncidentTime value={exclusion.revertedAt} />
            </p>
          ) : canManageMonitors ? (
            <Button
              disabled={Boolean(undo.id)}
              onClick={() => undoExclusion(exclusion.id)}
              size="sm"
              variant="secondary"
            >
              Undo
            </Button>
          ) : null}
        </article>
      ))}
      {undo.error ? (
        <p className="text-[13px] text-[var(--down-text)]" role="alert">
          {undo.error}
        </p>
      ) : null}
      {open ? (
        <ExclusionDialog
          defaultEndAt={defaultEndAt}
          defaultStartAt={defaultStartAt}
          incidentId={incidentId}
          onClose={() => setOpen(false)}
          onSaved={refresh}
        />
      ) : null}
    </section>
  )
}
