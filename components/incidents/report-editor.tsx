"use client"

import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import { useNavigationGuard } from "@/components/navigation/use-navigation-guard"
import {
  type ApiEnvelope,
  apiRequest,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { IncidentTime } from "./incident-time"
import {
  ReportDraftBadge,
  ReportStatusChip,
  ReportTypeChip,
} from "./report-badges"
import { messageForReportError } from "./report-errors"
import {
  BEFORE_START_COPY,
  datetimeLocalError,
  fromDatetimeLocal,
  impactOptions,
  isBeforeStart,
  REPORT_STATUS_LABELS,
  REPORT_STATUSES,
  type ReportData,
  type ReportFormErrors,
  type ReportImpact,
  type ReportType,
  type ReportUpdateData,
  type ReportUpdateStatus,
  resolveDatetimeLocal,
  STATE_FLIP_COPY,
  type StateFlipDirection,
  stateFlipAfterRemoval,
  stateFlipDirection,
  toDatetimeLocal,
  validateReportForm,
} from "./report-status"

export interface ReportEditorMonitor {
  id: string
  name: string
  group: string | null
}

type ImpactValue = ReportImpact | "none"

interface EditingUpdate {
  id: string
  status: ReportUpdateStatus
  markdown: string
  publishedAt: string
  warning: StateFlipDirection | null
  error: string
  timeError: string
}

/**
 * Where a message renders, so feedback lands next to the control that
 * triggered it. Row actions use `update:<id>`.
 */
type MessageAt =
  | "header"
  | "composer"
  | "timeline"
  | "older"
  | "footer"
  | `update:${string}`

interface Message {
  text: string
  tone: "info" | "error"
  at: MessageAt
}

function messageClass(tone: Message["tone"]): string {
  return tone === "error" ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"
}

function ActionMessage({
  message,
  className,
}: {
  message: Message | null
  className?: string
}) {
  if (!message) {
    return null
  }
  // Routine success already shows in the timeline, badge, or buttons, so it is
  // announced to screen readers only. The footer keeps Report saved visible.
  if (message.tone === "info") {
    return (
      <p className="sr-only" role="status">
        {message.text}
      </p>
    )
  }
  return (
    <p
      className={`min-w-0 break-words text-[13px] ${messageClass(message.tone)} ${className ?? ""}`}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.text}
    </p>
  )
}

/** Names the create outcome: a draft stays private, otherwise it goes live. */
function createLabel(draft: boolean, busy: boolean): string {
  if (draft) {
    return busy ? "Saving…" : "Save Draft"
  }
  return busy ? "Publishing…" : "Publish Report"
}

/** Field label with the display time zone, so typed times are unambiguous. */
function ZonedLabel({ text, timeZone }: { text: string; timeZone: string }) {
  return (
    <>
      {text}{" "}
      <span className="font-normal text-[var(--fg-muted)]">({timeZone})</span>
    </>
  )
}

const textareaClass =
  "w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px] aria-invalid:border-[var(--down-text)]"

export const UNSAVED_CHANGES_MESSAGE =
  "You have unsaved changes that will be lost. Leave this report?"

function initialImpacts(
  report: ReportData | null
): Record<string, ImpactValue> {
  const impacts: Record<string, ImpactValue> = {}
  for (const row of report?.affected ?? []) {
    impacts[row.monitorId] = row.impact
  }
  return impacts
}

interface EditorBaseline {
  title: string
  startsAt: string
  endsAt: string
  impacts: Record<string, ImpactValue>
}

/** Order-independent signature of the affected picks, ignoring "none" rows. */
function impactSignature(impacts: Record<string, ImpactValue>): string {
  return JSON.stringify(
    Object.entries(impacts)
      .filter((entry) => entry[1] !== "none")
      .sort((left, right) => left[0].localeCompare(right[0]))
  )
}

interface ReportEditorProps {
  report: ReportData | null
  monitors: ReportEditorMonitor[]
}

export function ReportEditor(props: ReportEditorProps) {
  const { resolvedTimeZone } = useTimezone()
  // Datetime fields hold wall-clock text in the display zone. The zone
  // settles after hydration, so remount on change to keep every field and
  // conversion in one zone.
  return (
    <ReportEditorForm
      key={resolvedTimeZone}
      {...props}
      timeZone={resolvedTimeZone}
    />
  )
}

function ReportEditorForm({
  report,
  monitors,
  timeZone,
}: ReportEditorProps & { timeZone: string }) {
  const router = useRouter()
  const [baseline, setBaseline] = useState<EditorBaseline>(() => ({
    title: report?.title ?? "",
    startsAt: toDatetimeLocal(
      report?.startsAt ?? new Date().toISOString(),
      timeZone
    ),
    endsAt: report?.endsAt ? toDatetimeLocal(report.endsAt, timeZone) : "",
    impacts: initialImpacts(report),
  }))
  const [title, setTitle] = useState(baseline.title)
  const [type, setType] = useState<ReportType>(report?.type ?? "incident")
  const [startsAt, setStartsAt] = useState(baseline.startsAt)
  const [endsAt, setEndsAt] = useState(baseline.endsAt)
  const [impacts, setImpacts] = useState<Record<string, ImpactValue>>(
    baseline.impacts
  )
  const [draft, setDraft] = useState(false)
  const [composerStatus, setComposerStatus] = useState<ReportUpdateStatus>(
    report ? report.currentStatus : REPORT_STATUSES[type][0]
  )
  const [composerMarkdown, setComposerMarkdown] = useState("")
  const [composerPublishedAt, setComposerPublishedAt] = useState(() =>
    toDatetimeLocal(new Date().toISOString(), timeZone)
  )
  const [errors, setErrors] = useState<ReportFormErrors>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [editing, setEditing] = useState<EditingUpdate | null>(null)
  const [confirmDeleteUpdateId, setConfirmDeleteUpdateId] = useState<
    string | null
  >(null)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Older timeline pages loaded through GET .../updates. Cleared on every
  // mutation success before refresh so the first page stays authoritative.
  const [olderUpdates, setOlderUpdates] = useState<ReportUpdateData[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadedPastFirstPage, setLoadedPastFirstPage] = useState(false)

  const timelineUpdates = useMemo(() => {
    if (!report) {
      return []
    }
    if (!loadedPastFirstPage || olderUpdates.length === 0) {
      return report.updates
    }
    const seen = new Set(report.updates.map((update) => update.id))
    return [
      ...report.updates,
      ...olderUpdates.filter((update) => !seen.has(update.id)),
    ]
  }, [report, olderUpdates, loadedPastFirstPage])

  const timelineNextCursor = loadedPastFirstPage
    ? olderCursor
    : (report?.updatesNextCursor ?? null)

  function resetOlderTimeline() {
    setOlderUpdates([])
    setOlderCursor(null)
    setLoadedPastFirstPage(false)
  }

  const basicsDirty =
    title !== baseline.title ||
    startsAt !== baseline.startsAt ||
    (type === "maintenance" && endsAt !== baseline.endsAt)
  const affectedDirty =
    impactSignature(impacts) !== impactSignature(baseline.impacts)
  const composerDirty = composerMarkdown.trim() !== ""
  const editingOriginal =
    editing && timelineUpdates.find((update) => update.id === editing.id)
  const editingDirty = editing
    ? !editingOriginal ||
      editing.status !== editingOriginal.status ||
      editing.markdown !== editingOriginal.markdown ||
      editing.publishedAt !==
        toDatetimeLocal(editingOriginal.publishedAt, timeZone)
    : false
  const dirty = basicsDirty || affectedDirty || composerDirty || editingDirty

  // Unsaved-changes protection: the editor lives outside the settings shell,
  // so it mounts its own navigation guard (beforeunload, Back/Forward, and
  // any link click document-wide: this also covers the back link and the
  // incidents tabs, which no longer need their own confirm). The guard's
  // dialog must be rendered below for the modal to appear.
  const guardDialog = useNavigationGuard(dirty, {
    title: "Discard unsaved changes?",
    description: UNSAVED_CHANGES_MESSAGE,
    confirmLabel: "Discard",
    cancelLabel: "Keep Editing",
  })

  const pickerGroups = useMemo(() => {
    const known = new Set(monitors.map((monitor) => monitor.id))
    const rows = [
      ...monitors,
      ...(report?.affected ?? [])
        .filter((row) => !known.has(row.monitorId))
        .map((row) => ({
          id: row.monitorId,
          name: `${row.monitorName} (archived)`,
          group: row.groupName,
        })),
    ]
    const groups = new Map<string, ReportEditorMonitor[]>()
    for (const row of rows) {
      const label = row.group ?? "Ungrouped"
      const section = groups.get(label) ?? []
      section.push(row)
      groups.set(label, section)
    }
    return [...groups.entries()]
  }, [monitors, report])

  const affectedBody = () =>
    Object.entries(impacts)
      .filter((entry): entry is [string, ReportImpact] => entry[1] !== "none")
      .map(([monitorId, impact]) => ({ monitorId, impact }))

  function changeType(next: ReportType) {
    setType(next)
    setComposerStatus(REPORT_STATUSES[next][0])
    const allowed = new Set(impactOptions(next).map((option) => option.value))
    setImpacts((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, value]) => [
          id,
          allowed.has(value) ? value : "none",
        ])
      )
    )
  }

  const originals = {
    startsAt: report?.startsAt ?? null,
    endsAt: report?.endsAt ?? null,
  }

  async function create() {
    const nextErrors = validateReportForm({
      title,
      startsAt,
      endsAt,
      type,
      requireUpdate: true,
      markdown: composerMarkdown,
      publishedAt: composerPublishedAt,
      timeZone,
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }
    setBusy("create")
    setMessage(null)
    try {
      const body = {
        type,
        title: title.trim(),
        startsAt: fromDatetimeLocal(startsAt, timeZone)!,
        ...(type === "maintenance" && endsAt.trim()
          ? { endsAt: fromDatetimeLocal(endsAt, timeZone)! }
          : {}),
        affected: affectedBody(),
        update: {
          status: composerStatus,
          markdown: composerMarkdown,
          publishedAt: fromDatetimeLocal(composerPublishedAt, timeZone)!,
        },
        ...(draft ? { draft: true } : {}),
      }
      const result = await apiRequest<ApiEnvelope<{ id: string }>>(
        "/api/v1/status-reports",
        { method: "POST", body: JSON.stringify(body) },
        { mutation: true }
      )
      router.push(`/incidents/reports/${encodeURIComponent(result.data.id)}`)
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: "footer",
      })
      setBusy(null)
    }
  }

  async function saveBasics() {
    if (!report) {
      return
    }
    const nextErrors = validateReportForm({
      title,
      startsAt,
      endsAt,
      type,
      requireUpdate: false,
      markdown: "",
      publishedAt: "",
      timeZone,
      originals,
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }
    setBusy("save")
    setMessage(null)
    try {
      // datetime-local drops seconds, so round-tripping an untouched value
      // would silently truncate startsAt/endsAt to minute precision on every
      // basics save. Only send them when the input actually differs from
      // the baseline.
      const startsAtChanged = startsAt !== baseline.startsAt
      const endsAtChanged = type === "maintenance" && endsAt !== baseline.endsAt
      // No If-Match on report edits (last-writer-wins): sending the
      // page-load title on an affected- or window-only save would clobber a
      // title another session changed meanwhile. Only send it when it
      // actually changed from the loaded baseline.
      const titleChanged = title.trim() !== baseline.title
      const body = {
        ...(titleChanged ? { title: title.trim() } : {}),
        ...(startsAtChanged
          ? {
              startsAt: resolveDatetimeLocal(
                startsAt,
                timeZone,
                originals.startsAt
              )!,
            }
          : {}),
        ...(endsAtChanged
          ? {
              endsAt: endsAt.trim()
                ? resolveDatetimeLocal(endsAt, timeZone, originals.endsAt)!
                : null,
            }
          : {}),
        // Only send affected when it actually changed: the service treats
        // this key as a full replacement that re-snapshots monitor
        // names/groups from the live registry, so sending it unconditionally
        // would silently rewrite the historical snapshot on every basics-only
        // save (e.g. after a monitor was renamed or moved groups).
        ...(affectedDirty ? { affected: affectedBody() } : {}),
      }
      if (Object.keys(body).length === 0) {
        setBaseline({ title: title.trim(), startsAt, endsAt, impacts })
        return
      }
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}`,
        { method: "PATCH", body: JSON.stringify(body) },
        { mutation: true }
      )
      setBaseline({ title: title.trim(), startsAt, endsAt, impacts })
      resetOlderTimeline()
      setMessage({ text: "Report saved", tone: "info", at: "footer" })
      router.refresh()
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: "footer",
      })
    } finally {
      setBusy(null)
    }
  }

  async function postUpdate() {
    if (!report) {
      return
    }
    const nextErrors = validateReportForm({
      title: report.title,
      startsAt,
      endsAt: "",
      type,
      requireUpdate: true,
      markdown: composerMarkdown,
      publishedAt: composerPublishedAt,
      timeZone,
      originals,
    })
    setErrors({
      markdown: nextErrors.markdown,
      publishedAt: nextErrors.publishedAt,
    })
    if (nextErrors.markdown || nextErrors.publishedAt) {
      return
    }
    setBusy("post")
    setMessage(null)
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates`,
        {
          method: "POST",
          body: JSON.stringify({
            status: composerStatus,
            markdown: composerMarkdown,
            publishedAt: fromDatetimeLocal(composerPublishedAt, timeZone)!,
          }),
        },
        { mutation: true }
      )
      setComposerMarkdown("")
      setComposerPublishedAt(
        toDatetimeLocal(new Date().toISOString(), timeZone)
      )
      resetOlderTimeline()
      setMessage({ text: "Update posted", tone: "info", at: "composer" })
      router.refresh()
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: "composer",
      })
    } finally {
      setBusy(null)
    }
  }

  async function loadOlderUpdates() {
    if (!(report && timelineNextCursor)) {
      return
    }
    setBusy("load-older")
    setMessage(null)
    try {
      const result = await apiRequest<
        ApiEnvelope<ReportUpdateData[]> & {
          meta?: { nextCursor?: string | null }
        }
      >(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates?cursor=${encodeURIComponent(timelineNextCursor)}&limit=50`
      )
      setOlderUpdates((current) => [...current, ...result.data])
      setOlderCursor(result.meta?.nextCursor ?? null)
      setLoadedPastFirstPage(true)
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: "older",
      })
    } finally {
      setBusy(null)
    }
  }

  function startEditUpdate(updateId: string) {
    const update = timelineUpdates.find((entry) => entry.id === updateId)
    if (!update) {
      return
    }
    setConfirmDeleteUpdateId(null)
    setEditing({
      id: update.id,
      status: update.status,
      markdown: update.markdown,
      publishedAt: toDatetimeLocal(update.publishedAt, timeZone),
      warning: null,
      error: "",
      timeError: "",
    })
  }

  function setEditingField(
    patch: Partial<Pick<EditingUpdate, "status" | "markdown" | "publishedAt">>
  ) {
    setEditing((current) =>
      current
        ? { ...current, ...patch, warning: null, error: "", timeError: "" }
        : current
    )
  }

  async function saveEditedUpdate() {
    if (!(report && editing)) {
      return
    }
    if (!editing.markdown.trim()) {
      setEditing({ ...editing, error: "Update body is required" })
      return
    }
    // datetime-local drops seconds, so round-tripping an untouched value would
    // silently rewrite publishedAt at minute precision. Only send it (and only
    // apply it to the flip check) when the input actually changed.
    const original = timelineUpdates.find((update) => update.id === editing.id)
    const publishedAtChanged =
      !original ||
      editing.publishedAt !== toDatetimeLocal(original.publishedAt, timeZone)
    const publishedAt = publishedAtChanged
      ? fromDatetimeLocal(editing.publishedAt, timeZone)
      : null
    if (publishedAtChanged && !publishedAt) {
      setEditing({
        ...editing,
        timeError: datetimeLocalError(editing.publishedAt, timeZone) ?? "",
      })
      return
    }
    // No If-Match on report-update edits, so sending the page-load
    // status/markdown on a publishedAt-only edit would clobber a concurrent
    // change to either field. Only send each when it actually changed from
    // the loaded update.
    const statusChanged = !original || editing.status !== original.status
    const markdownChanged = !original || editing.markdown !== original.markdown
    // An edited timestamp or status that flips the report between Ongoing
    // and Resolved needs an explicit second confirmation.
    const flip = stateFlipDirection(timelineUpdates, {
      id: editing.id,
      status: editing.status,
      ...(publishedAtChanged && publishedAt ? { publishedAt } : {}),
    })
    if (flip && editing.warning === null) {
      setEditing({ ...editing, warning: flip, error: "", timeError: "" })
      return
    }
    if (!(statusChanged || markdownChanged || publishedAtChanged)) {
      setEditing(null)
      return
    }
    setBusy(`edit:${editing.id}`)
    setMessage(null)
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates/${encodeURIComponent(editing.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(statusChanged ? { status: editing.status } : {}),
            ...(markdownChanged ? { markdown: editing.markdown } : {}),
            ...(publishedAtChanged && publishedAt ? { publishedAt } : {}),
          }),
        },
        { mutation: true }
      )
      setEditing(null)
      resetOlderTimeline()
      setMessage({
        text: "Update saved",
        tone: "info",
        at: `update:${editing.id}`,
      })
      router.refresh()
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: `update:${editing.id}`,
      })
    } finally {
      setBusy(null)
    }
  }

  async function deleteUpdate(updateId: string) {
    if (!report) {
      return
    }
    setBusy(`delete-update:${updateId}`)
    setMessage(null)
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates/${encodeURIComponent(updateId)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      setConfirmDeleteUpdateId(null)
      resetOlderTimeline()
      // The row is gone after refresh, so confirm above the timeline.
      setMessage({ text: "Update deleted", tone: "info", at: "timeline" })
      router.refresh()
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: `update:${updateId}`,
      })
    } finally {
      setBusy(null)
    }
  }

  async function publish() {
    if (!report) {
      return
    }
    setBusy("publish")
    setMessage(null)
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/publish`,
        { method: "POST" },
        { mutation: true }
      )
      setConfirmPublish(false)
      resetOlderTimeline()
      setMessage({ text: "Report published", tone: "info", at: "header" })
      router.refresh()
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: "header",
      })
    } finally {
      setBusy(null)
    }
  }

  async function deleteReport() {
    if (!report) {
      return
    }
    setBusy("delete")
    setMessage(null)
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      router.push("/incidents/reports")
    } catch (cause) {
      setMessage({
        text: messageForReportError(cause),
        tone: "error",
        at: "header",
      })
      setBusy(null)
    }
  }

  const statuses = REPORT_STATUSES[type]
  const anyBusy = busy !== null
  const messageAt = (at: MessageAt) => (message?.at === at ? message : null)
  const footerMessage = messageAt("footer")
  const timelineMessage = messageAt("timeline")

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl tracking-[-0.02em]">
          {report ? "Edit status report" : "New status report"}
        </h1>
        {report && report.publishedAt === null ? <ReportDraftBadge /> : null}
        {report?.type === "maintenance" ? <ReportTypeChip /> : null}
        {report ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {report.publishedAt === null ? (
              confirmPublish ? (
                <span className="flex items-center gap-2">
                  <span className="max-w-64 text-[var(--fg-muted)] text-xs">
                    Publishing makes this report publicly visible on your status
                    page.
                  </span>
                  <Button
                    className="px-2.5"
                    disabled={anyBusy}
                    onClick={() => void publish()}
                    size="sm"
                  >
                    {busy === "publish" ? "Publishing…" : "Confirm"}
                  </Button>
                  <Button
                    className="px-2.5"
                    disabled={anyBusy}
                    onClick={() => setConfirmPublish(false)}
                    size="sm"
                    variant="secondary"
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  className="px-2.5"
                  disabled={anyBusy}
                  onClick={() => setConfirmPublish(true)}
                  size="sm"
                >
                  Publish
                </Button>
              )
            ) : null}
            {confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-[var(--fg-muted)] text-xs">
                  Delete report?
                </span>
                <Button
                  className="px-2.5"
                  disabled={anyBusy}
                  onClick={() => void deleteReport()}
                  size="sm"
                  variant="error"
                >
                  {busy === "delete" ? "Deleting…" : "Confirm"}
                </Button>
                <Button
                  className="px-2.5"
                  disabled={anyBusy}
                  onClick={() => setConfirmDelete(false)}
                  size="sm"
                  variant="secondary"
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                className="px-2.5"
                disabled={anyBusy}
                onClick={() => setConfirmDelete(true)}
                size="sm"
                variant="error-outline"
              >
                Delete
              </Button>
            )}
          </div>
        ) : null}
        <ActionMessage
          className="basis-full text-right"
          message={messageAt("header")}
        />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field error={errors.title} htmlFor="report-title" label="Title">
                <Input
                  aria-invalid={Boolean(errors.title)}
                  id="report-title"
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={
                    type === "maintenance"
                      ? "Scheduled database maintenance"
                      : "Elevated API error rates"
                  }
                  value={title}
                />
              </Field>
              <div className="grid gap-2">
                {/* biome-ignore lint/a11y/noLabelWithoutControl: linked to the Select via aria-labelledby on its trigger */}
                <label
                  className="font-medium text-[var(--fg)] text-sm leading-5"
                  id="report-type-label"
                >
                  Type
                </label>
                <Select
                  disabled={Boolean(report)}
                  onValueChange={(value) => changeType(value as ReportType)}
                  value={type}
                >
                  <SelectTrigger
                    aria-describedby={report ? "report-type-locked" : undefined}
                    aria-labelledby="report-type-label"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="incident">Incident</SelectItem>
                    <SelectItem value="maintenance">Maintenance</SelectItem>
                  </SelectContent>
                </Select>
                {report ? (
                  <p className="sr-only" id="report-type-locked">
                    Type is locked after creation
                  </p>
                ) : null}
              </div>
              <Field
                error={errors.startsAt}
                htmlFor="report-starts"
                label={<ZonedLabel text="Starts at" timeZone={timeZone} />}
              >
                <Input
                  aria-invalid={Boolean(errors.startsAt)}
                  id="report-starts"
                  onChange={(event) => setStartsAt(event.target.value)}
                  type="datetime-local"
                  value={startsAt}
                />
              </Field>
              {type === "maintenance" ? (
                <Field
                  description="Optional"
                  error={errors.endsAt}
                  htmlFor="report-ends"
                  label={<ZonedLabel text="Ends at" timeZone={timeZone} />}
                >
                  <Input
                    aria-invalid={Boolean(errors.endsAt)}
                    id="report-ends"
                    onChange={(event) => setEndsAt(event.target.value)}
                    type="datetime-local"
                    value={endsAt}
                  />
                </Field>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Update Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: linked to the Select via aria-labelledby on its trigger */}
                    <label
                      className="font-medium text-[var(--fg)] text-sm leading-5"
                      id="composer-status-label"
                    >
                      Status
                    </label>
                    <Select
                      onValueChange={(value) =>
                        setComposerStatus(value as ReportUpdateStatus)
                      }
                      value={composerStatus}
                    >
                      <SelectTrigger aria-labelledby="composer-status-label">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((status) => (
                          <SelectItem key={status} value={status}>
                            {REPORT_STATUS_LABELS[status]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    error={errors.publishedAt}
                    htmlFor="composer-published"
                    label={
                      <ZonedLabel text="Published at" timeZone={timeZone} />
                    }
                  >
                    <Input
                      aria-invalid={Boolean(errors.publishedAt)}
                      id="composer-published"
                      onChange={(event) =>
                        setComposerPublishedAt(event.target.value)
                      }
                      type="datetime-local"
                      value={composerPublishedAt}
                    />
                  </Field>
                </div>
                {isBeforeStart(
                  composerPublishedAt,
                  startsAt,
                  timeZone,
                  originals
                ) ? (
                  <p
                    className="text-[13px] text-[var(--down-text)]"
                    role="status"
                  >
                    {BEFORE_START_COPY}
                  </p>
                ) : null}
                <Field
                  description="You can use markdown."
                  error={errors.markdown}
                  htmlFor="composer-markdown"
                  label={report ? "New update" : "Initial update"}
                >
                  <textarea
                    aria-invalid={Boolean(errors.markdown)}
                    className={textareaClass}
                    id="composer-markdown"
                    onChange={(event) =>
                      setComposerMarkdown(event.target.value)
                    }
                    rows={4}
                    value={composerMarkdown}
                  />
                </Field>
                {report ? (
                  <div className="flex items-center justify-end gap-3">
                    <ActionMessage message={messageAt("composer")} />
                    <Button
                      className="shrink-0 px-2.5"
                      disabled={anyBusy}
                      onClick={() => void postUpdate()}
                      size="sm"
                    >
                      {busy === "post" ? "Posting…" : "Post Update"}
                    </Button>
                  </div>
                ) : null}
              </div>

              {report ? (
                <ul className="space-y-4 border-[var(--border)] border-t pt-5">
                  {timelineMessage ? (
                    // A hidden success keeps the list item out of the layout
                    <li
                      className={
                        timelineMessage.tone === "error" ? undefined : "sr-only"
                      }
                    >
                      <ActionMessage message={timelineMessage} />
                    </li>
                  ) : null}
                  {timelineUpdates.map((update) => {
                    // Deleting the latest resolving update can flip the
                    // report back to Ongoing. Warn inside the delete confirm.
                    const deleteFlip =
                      confirmDeleteUpdateId === update.id
                        ? stateFlipAfterRemoval(timelineUpdates, update.id)
                        : null
                    return (
                      <li
                        className="rounded-[8px] border border-[var(--border-strong)] p-4"
                        key={update.id}
                      >
                        {editing?.id === update.id ? (
                          <div className="space-y-3">
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div className="grid gap-2">
                                {/* biome-ignore lint/a11y/noLabelWithoutControl: linked to the Select via aria-labelledby on its trigger */}
                                <label
                                  className="font-medium text-[13px]"
                                  id={`edit-status-label-${update.id}`}
                                >
                                  Status
                                </label>
                                <Select
                                  onValueChange={(value) =>
                                    setEditingField({
                                      status: value as ReportUpdateStatus,
                                    })
                                  }
                                  value={editing.status}
                                >
                                  <SelectTrigger
                                    aria-labelledby={`edit-status-label-${update.id}`}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {statuses.map((status) => (
                                      <SelectItem key={status} value={status}>
                                        {REPORT_STATUS_LABELS[status]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <Field
                                error={editing.timeError || undefined}
                                htmlFor={`edit-published-${update.id}`}
                                label={
                                  <ZonedLabel
                                    text="Published at"
                                    timeZone={timeZone}
                                  />
                                }
                              >
                                <Input
                                  aria-invalid={Boolean(editing.timeError)}
                                  id={`edit-published-${update.id}`}
                                  onChange={(event) =>
                                    setEditingField({
                                      publishedAt: event.target.value,
                                    })
                                  }
                                  type="datetime-local"
                                  value={editing.publishedAt}
                                />
                              </Field>
                            </div>
                            {isBeforeStart(
                              editing.publishedAt,
                              startsAt,
                              timeZone,
                              {
                                startsAt: originals.startsAt,
                                publishedAt: update.publishedAt,
                              }
                            ) ? (
                              <p
                                className="text-[13px] text-[var(--down-text)]"
                                role="status"
                              >
                                {BEFORE_START_COPY}
                              </p>
                            ) : null}
                            <Field
                              description="You can use markdown."
                              error={editing.error || undefined}
                              htmlFor={`edit-markdown-${update.id}`}
                              label="Update"
                            >
                              <textarea
                                aria-invalid={Boolean(editing.error)}
                                className={textareaClass}
                                id={`edit-markdown-${update.id}`}
                                onChange={(event) =>
                                  setEditingField({
                                    markdown: event.target.value,
                                  })
                                }
                                rows={4}
                                value={editing.markdown}
                              />
                            </Field>
                            {editing.warning ? (
                              <p
                                className="text-[13px] text-[var(--down-text)]"
                                role="status"
                              >
                                {STATE_FLIP_COPY[editing.warning]}
                              </p>
                            ) : null}
                            <div className="flex justify-end gap-2">
                              <Button
                                className="px-2.5"
                                disabled={anyBusy}
                                onClick={() => setEditing(null)}
                                size="sm"
                                variant="secondary"
                              >
                                Cancel
                              </Button>
                              <Button
                                className="px-2.5"
                                disabled={anyBusy}
                                onClick={() => void saveEditedUpdate()}
                                size="sm"
                              >
                                {busy === `edit:${update.id}`
                                  ? "Saving…"
                                  : editing.warning
                                    ? "Save Anyway"
                                    : "Save Update"}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex flex-wrap items-center gap-2">
                              <ReportStatusChip status={update.status} />
                              <span className="font-data text-[var(--fg-muted)] text-xs">
                                <IncidentTime value={update.publishedAt} />
                              </span>
                              <span className="ml-auto flex items-center gap-1">
                                {confirmDeleteUpdateId === update.id ? (
                                  <>
                                    {deleteFlip ? (
                                      <span
                                        className="max-w-72 text-[var(--down-text)] text-xs"
                                        role="status"
                                      >
                                        {STATE_FLIP_COPY[deleteFlip]}
                                      </span>
                                    ) : null}
                                    <span className="text-[var(--fg-muted)] text-xs">
                                      Delete update?
                                    </span>
                                    <Button
                                      className="px-2.5"
                                      disabled={anyBusy}
                                      onClick={() =>
                                        void deleteUpdate(update.id)
                                      }
                                      size="sm"
                                      variant="error"
                                    >
                                      {busy === `delete-update:${update.id}`
                                        ? "Deleting…"
                                        : "Confirm"}
                                    </Button>
                                    <Button
                                      className="px-2.5"
                                      disabled={anyBusy}
                                      onClick={() =>
                                        setConfirmDeleteUpdateId(null)
                                      }
                                      size="sm"
                                      variant="secondary"
                                    >
                                      Cancel
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      className="px-2"
                                      disabled={anyBusy}
                                      onClick={() => startEditUpdate(update.id)}
                                      size="sm"
                                      variant="tertiary"
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      className="px-2 text-[var(--down-text)]"
                                      disabled={anyBusy}
                                      onClick={() =>
                                        setConfirmDeleteUpdateId(update.id)
                                      }
                                      size="sm"
                                      variant="tertiary"
                                    >
                                      Delete
                                    </Button>
                                  </>
                                )}
                              </span>
                            </div>
                            <p className="mt-2 whitespace-pre-wrap break-words font-data text-[13px]">
                              {update.markdown}
                            </p>
                          </>
                        )}
                        <ActionMessage
                          className="mt-3"
                          message={messageAt(`update:${update.id}`)}
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              {report && timelineNextCursor ? (
                <div className="flex flex-col items-center gap-2 border-[var(--border)] border-t pt-4">
                  <ActionMessage message={messageAt("older")} />
                  <Button
                    className="px-2.5"
                    disabled={anyBusy}
                    onClick={() => void loadOlderUpdates()}
                    size="sm"
                    variant="secondary"
                  >
                    {busy === "load-older" ? "Loading…" : "Load older"}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Affected Services</CardTitle>
            <CardDescription>
              Impact shown per service on the status page
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {pickerGroups.length === 0 ? (
              <p className="text-[13px] text-[var(--fg-muted)]">
                No monitors configured.
              </p>
            ) : (
              pickerGroups.map(([groupName, rows]) => (
                <section aria-label={groupName} key={groupName}>
                  <h3 className="mb-2 font-medium text-[var(--fg-muted)] text-xs">
                    {groupName}
                  </h3>
                  <ul className="space-y-2">
                    {rows.map((row) => (
                      <li
                        className="flex items-center justify-between gap-3"
                        key={row.id}
                      >
                        <span className="min-w-0 break-words text-[13px]">
                          {row.name}
                        </span>
                        <Select
                          onValueChange={(value) =>
                            setImpacts((current) => ({
                              ...current,
                              [row.id]: value as ImpactValue,
                            }))
                          }
                          value={impacts[row.id] ?? "none"}
                        >
                          <SelectTrigger
                            aria-label={`Impact for ${row.name}`}
                            className="h-8 w-36 shrink-0 text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {impactOptions(type).map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p
          aria-live="polite"
          className={`min-w-0 break-words text-[13px] ${messageClass(footerMessage?.tone ?? "info")}`}
        >
          {footerMessage?.text ?? ""}
        </p>
        <div className="flex items-center gap-4">
          {report ? (
            <Button
              disabled={anyBusy || !(basicsDirty || affectedDirty)}
              onClick={() => void saveBasics()}
            >
              {busy === "save" ? "Saving…" : "Save Changes"}
            </Button>
          ) : (
            <>
              <label className="flex items-center gap-2 font-medium text-[13px]">
                <input
                  checked={draft}
                  className="size-4 accent-[var(--fg)]"
                  onChange={(event) => setDraft(event.target.checked)}
                  type="checkbox"
                />
                Save as draft
              </label>
              <Button disabled={anyBusy} onClick={() => void create()}>
                {createLabel(draft, busy === "create")}
              </Button>
            </>
          )}
        </div>
      </div>
      {guardDialog}
    </div>
  )
}
