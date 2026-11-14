"use client"

import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"
import useSWR, { useSWRConfig } from "swr"

import { IncidentTime } from "@/components/incidents/incident-time"
import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"
import type {
  IncidentExclusionPreview,
  IncidentExclusionRecord,
} from "@/lib/incidents/exclusions"

function localInput(value: string): string {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

function uptime(value: number | null): string {
  return value === null ? "No eligible checks" : `${value.toFixed(3)}%`
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
  // The range override and reason are user input, independent of server state.
  const [range, setRange] = useState<{ startAt: string; endAt: string } | null>(
    null
  )
  const [reason, setReason] = useState("")
  const [submission, setSubmission] = useState({ busy: false, error: "" })
  const retry = useRef<{ body: string; key: string } | null>(null)
  const path = `/api/v1/incidents/${encodeURIComponent(incidentId)}/exclusions`
  const validRange =
    !range || (range.startAt && range.endAt && range.startAt < range.endAt)
  const body =
    range && validRange
      ? {
          startAt: new Date(range.startAt).toISOString(),
          endAt: new Date(range.endAt).toISOString(),
        }
      : {}
  const {
    data: preview,
    error,
    isValidating,
    mutate,
  } = useSWR(
    validRange ? [path, JSON.stringify(body)] : null,
    async ([url, requestBody]: [string, string]) => {
      const response = await apiRequest<ApiEnvelope<IncidentExclusionPreview>>(
        `${url}/preview`,
        { method: "POST", body: requestBody }
      )
      return response.data
    },
    { shouldRetryOnError: false, revalidateOnFocus: true }
  )

  // Native dialog focus, Escape, and focus restoration are browser behavior.
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!(preview && reason.trim()) || submission.busy || isValidating) {
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
        {preview ? (
          <div className="space-y-3 text-[13px]">
            <p>Excluded interval</p>
            <p className="font-data text-[var(--fg-muted)]">
              <IncidentTime value={preview.startAt} /> to{" "}
              <IncidentTime value={preview.endAt} />
            </p>
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            checked={range !== null}
            disabled={submission.busy}
            onChange={(event) =>
              setRange(
                event.target.checked
                  ? {
                      startAt: localInput(preview?.startAt ?? defaultStartAt),
                      endAt: localInput(
                        preview?.endAt ??
                          defaultEndAt ??
                          new Date(
                            Math.floor(Date.now() / 60_000) * 60_000
                          ).toISOString()
                      ),
                    }
                  : null
              )
            }
            type="checkbox"
          />
          Choose a narrower interval
        </label>
        {range ? (
          <fieldset className="space-y-4" disabled={submission.busy}>
            <label className="block space-y-1.5">
              <span className="text-[13px]">Start, local time</span>
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
              <span className="text-[13px]">End, local time</span>
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
        {preview && !isValidating ? (
          <div
            className="space-y-2 rounded-lg border border-[var(--border)] p-4 text-[13px]"
            role="status"
          >
            <p>{preview.affectedFailedChecks} failed checks excluded</p>
            <p>
              24-hour uptime: {uptime(preview.before.uptime)} →{" "}
              {uptime(preview.after.uptime)}
            </p>
            <p className="text-[var(--fg-muted)]">
              Completed window ending <IncidentTime value={preview.windowEnd} />
            </p>
          </div>
        ) : null}
        {error || !validRange ? (
          <p className="text-[13px] text-[var(--down-text)]" role="alert">
            {error ? messageForError(error) : "Choose an end after the start"}
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
              !validRange ||
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
  exclusions: IncidentExclusionRecord[]
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
            {exclusion.revertedAt
              ? "Exclusion undone"
              : "Excluded from downtime"}
          </p>
          <p className="font-data text-[var(--fg-muted)]">
            <IncidentTime value={exclusion.startAt} /> to{" "}
            <IncidentTime value={exclusion.endAt} />
          </p>
          <p className="whitespace-pre-wrap break-words">{exclusion.reason}</p>
          <p className="break-words text-[var(--fg-muted)]">
            {exclusion.createdByPrincipal} ·{" "}
            <IncidentTime value={exclusion.createdAt} />
          </p>
          {exclusion.revertedAt ? (
            <p className="break-words text-[var(--fg-muted)]">
              Undone by {exclusion.revertedByPrincipal} ·{" "}
              <IncidentTime value={exclusion.revertedAt} />
            </p>
          ) : canManageMonitors ? (
            <Button
              disabled={Boolean(undo.id)}
              onClick={() => undoExclusion(exclusion.id)}
              size="sm"
              variant="secondary"
            >
              Undo exclusion
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
