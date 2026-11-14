"use client"

import { Activity, Archive, ChevronDown } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import {
  deriveMonitorName,
  type EditableMonitor,
  emptyNumericMonitorValues,
  hasAdvancedMonitorErrors,
  isPublicMonitorUrl,
  monitorMutationBody,
  type NumericMonitorFormValues,
  numericMonitorValidation,
  numericMonitorValues,
  validateMonitorValues,
} from "@/components/monitors/monitor-form"
import { runMonitorTest } from "@/components/monitors/monitor-test"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GroupDialog } from "./group-dialog"
import { MonitorGroupField } from "./monitor-group-field"
import {
  apiRequest,
  generatedMonitorId,
  messageForError,
  type SettingsGroup,
} from "./settings-api"
import { DISCARD_PROMPT } from "./settings-dirty"
import { Sheet, SheetIconButton } from "./sheet"

export type { EditableMonitor } from "@/components/monitors/monitor-form"

// recipientsText is the single source for recipients while editing. The form
// parses it back to a list only on submit, so the raw EditableMonitor
// recipients array is not carried in form state.
export type MonitorFormValues = NumericMonitorFormValues
export type MonitorFormErrors = Partial<Record<keyof MonitorFormValues, string>>

export function hasAdvancedMonitorFormErrors(
  errors: MonitorFormErrors
): boolean {
  return hasAdvancedMonitorErrors(errors)
}

// Pause and resume live in the Enabled field, so the header only runs a test
// or archives.
export function monitorSheetActionLabels() {
  return ["Run Test", "Archive"] as const
}

interface SheetStatus {
  message: string
  error: boolean
  // Routine progress and success that the buttons already show. Announced to
  // screen readers only.
  quiet?: boolean
}

function isDirty(values: MonitorFormValues, baseline: MonitorFormValues) {
  return (Object.keys(baseline) as (keyof MonitorFormValues)[]).some(
    (key) => values[key] !== baseline[key]
  )
}

function valuesFor(monitor: EditableMonitor | null): MonitorFormValues {
  return monitor
    ? numericMonitorValues(monitor)
    : structuredClone(emptyNumericMonitorValues)
}

export { deriveMonitorName, isPublicMonitorUrl }

export function validateMonitorForm(
  values: MonitorFormValues
): MonitorFormErrors {
  return validateMonitorValues(values, numericMonitorValidation)
}

function NumberField({
  label,
  value,
  error,
  onChange,
  min,
  max,
}: {
  label: string
  value: number
  error?: string
  onChange: (value: number) => void
  min: number
  max: number
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-medium text-[13px]">{label}</span>
      {/* min-w-0 lets the two column advanced grid shrink below the input's
          intrinsic width inside the narrow sheet instead of overflowing */}
      <input
        aria-invalid={Boolean(error)}
        className="h-10 w-full min-w-0 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 font-data text-[13px]"
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        type="number"
        value={value}
      />
      {error ? (
        <span className="mt-1 block text-[var(--down-text)] text-xs">
          {error}
        </span>
      ) : null}
    </label>
  )
}

function ArchiveDialog({
  monitorName,
  value,
  busy,
  status,
  onValueChange,
  onCancel,
  onConfirm,
}: {
  monitorName: string
  value: string
  busy: boolean
  status: SheetStatus | null
  onValueChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      aria-labelledby="archive-title"
      className="fixed inset-0 z-50 m-auto w-[min(400px,calc(100vw-32px))] rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      ref={ref}
    >
      <h3 className="font-semibold text-base" id="archive-title">
        Archive Monitor
      </h3>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        Checks stop and history stays available
      </p>
      <label className="mt-4 block text-[13px]">
        <span className="mb-2 block">
          Type <strong>{monitorName}</strong> to confirm
        </span>
        <input
          autoFocus
          className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]"
          onChange={(e) => onValueChange(e.target.value)}
          value={value}
        />
      </label>
      {status ? (
        <p
          aria-live="polite"
          className={`mt-3 text-[13px] ${status.error ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}
        >
          {status.message}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel} variant="secondary">
          Cancel
        </Button>
        <Button
          disabled={value !== monitorName || busy}
          onClick={onConfirm}
          variant="error"
        >
          {busy ? "Archiving…" : "Archive Monitor"}
        </Button>
      </div>
    </dialog>
  )
}

export function MonitorSheet({
  open,
  monitor,
  groups,
  onGroupCreated,
  onMonitorGroupChanged,
  onArchived,
  onClose,
}: {
  open: boolean
  monitor: EditableMonitor | null
  groups: readonly SettingsGroup[]
  onGroupCreated: (group: SettingsGroup) => void
  onMonitorGroupChanged?: (
    previousGroupId: string | null,
    nextGroupId: string | null
  ) => void
  // Replaces the default refresh and close after an archive, for example to
  // leave a detail page that no longer exists.
  onArchived?: () => void
  onClose: () => void
}) {
  const router = useRouter()
  const firstField = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [values, setValues] = useState<MonitorFormValues>(() =>
    valuesFor(monitor)
  )
  const [errors, setErrors] = useState<MonitorFormErrors>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<SheetStatus | null>(null)
  const [archiveName, setArchiveName] = useState("")
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [createGroup, setCreateGroup] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const propagationTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    requestAnimationFrame(() => firstField.current?.focus())
  }, [open])

  useEffect(
    () => () => {
      if (propagationTimer.current !== null) {
        window.clearTimeout(propagationTimer.current)
      }
    },
    []
  )

  const set = <K extends keyof MonitorFormValues>(
    key: K,
    value: MonitorFormValues[K]
  ) => setValues((current) => ({ ...current, [key]: value }))

  const lastDerivedName = useRef("")

  // URL edits fill the name only while it is empty or still machine derived,
  // a manually entered name is never overwritten and an existing monitor
  // never has its name rewritten.
  function updateUrl(url: string) {
    if (
      monitor ||
      (values.name !== "" && values.name !== lastDerivedName.current)
    ) {
      set("url", url)
      return
    }
    const name = deriveMonitorName(url)
    lastDerivedName.current = name
    setValues((current) => ({ ...current, url, name }))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const nextErrors = validateMonitorForm(values)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      if (hasAdvancedMonitorFormErrors(nextErrors)) {
        setAdvancedOpen(true)
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          formRef.current
            ?.querySelector<HTMLElement>("[aria-invalid='true']")
            ?.focus()
        )
      )
      return
    }
    setBusy("save")
    setStatus(null)
    const body = monitorMutationBody(values, { trimUrl: true })
    try {
      if (monitor) {
        await apiRequest(
          `/api/v1/monitors/${encodeURIComponent(monitor.id)}`,
          { method: "PATCH", body: JSON.stringify(body) },
          { mutation: true }
        )
      } else {
        await apiRequest(
          "/api/v1/monitors",
          {
            method: "POST",
            body: JSON.stringify({
              id: generatedMonitorId(values.name),
              ...body,
            }),
          },
          { mutation: true }
        )
      }
      onMonitorGroupChanged?.(monitor?.groupId ?? null, values.groupId)
      setStatus({
        message: "Updating configuration…",
        error: false,
        quiet: true,
      })
      setBusy("propagation")
      propagationTimer.current = window.setTimeout(() => {
        router.refresh()
        onClose()
      }, 10_000)
    } catch (error) {
      setStatus({ message: messageForError(error), error: true })
    } finally {
      setBusy((current) => (current === "propagation" ? current : null))
    }
  }

  async function runTest() {
    if (!monitor) {
      return
    }
    setBusy("test")
    setStatus({ message: "Testing…", error: false, quiet: true })
    const outcome = await runMonitorTest(monitor.id)
    setStatus({
      message: outcome.message,
      error: outcome.status === "error",
      quiet: outcome.status !== "error",
    })
    setBusy(null)
    if (outcome.status === "success") {
      router.refresh()
    }
  }

  async function archive() {
    if (!monitor || archiveName !== monitor.name) {
      return
    }
    setBusy("archive")
    setStatus(null)
    try {
      await apiRequest(
        `/api/v1/monitors/${encodeURIComponent(monitor.id)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      onMonitorGroupChanged?.(monitor.groupId, null)
      setStatus({ message: "Monitor archived", error: false })
      setBusy("archived")
      propagationTimer.current = window.setTimeout(() => {
        if (onArchived) {
          onArchived()
          return
        }
        router.refresh()
        onClose()
      }, 800)
    } catch (error) {
      setStatus({ message: messageForError(error), error: true })
    } finally {
      setBusy((current) => (current === "archived" ? current : null))
    }
  }

  const inputClass =
    "h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]"
  const [testLabel, archiveLabel] = monitorSheetActionLabels()
  const dirty = isDirty(values, valuesFor(monitor))
  // Close, Escape, and Cancel all route here, so unsaved edits are never
  // dropped without a prompt. A clean form closes at once.
  function requestClose() {
    if (busy) {
      return
    }
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }
  const actionBusyDescription = "Another monitor action is in progress"
  function createdGroup(group: SettingsGroup) {
    onGroupCreated(group)
    set("groupId", group.id)
    setCreateGroup(false)
  }
  return (
    <>
      <Sheet
        closeDisabled={Boolean(busy)}
        description={monitor ? monitor.id : "Add a public endpoint"}
        headerActions={
          monitor ? (
            <>
              <SheetIconButton
                disabled={Boolean(busy)}
                disabledDescription={actionBusyDescription}
                label={testLabel}
                onClick={() => void runTest()}
              >
                <Activity aria-hidden className="size-4" />
              </SheetIconButton>
              <SheetIconButton
                destructive
                disabled={Boolean(busy)}
                disabledDescription={actionBusyDescription}
                label={archiveLabel}
                onClick={() => setConfirmArchive(true)}
              >
                <Archive aria-hidden className="size-4" />
              </SheetIconButton>
            </>
          ) : undefined
        }
        onClose={requestClose}
        open={open}
        title={monitor ? "Edit Monitor" : "New Monitor"}
      >
        <form className="space-y-4" onSubmit={submit} ref={formRef}>
          <label className="block">
            <span className="mb-1.5 block font-medium text-[13px]">URL</span>
            <input
              aria-invalid={Boolean(errors.url)}
              className={`${inputClass} font-data`}
              onChange={(e) => updateUrl(e.target.value)}
              placeholder="https://inference.superposition.app/health"
              ref={firstField}
              value={values.url}
            />
            {errors.url ? (
              <span className="mt-1 block text-[var(--down-text)] text-xs">
                {errors.url}
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="mb-1.5 block font-medium text-[13px]">Name</span>
            <input
              aria-invalid={Boolean(errors.name)}
              className={inputClass}
              onChange={(e) => set("name", e.target.value)}
              value={values.name}
            />
            {errors.name ? (
              <span className="mt-1 block text-[var(--down-text)] text-xs">
                {errors.name}
              </span>
            ) : null}
          </label>
          <MonitorGroupField
            groups={groups}
            labelClassName="text-[13px]"
            onChange={(groupId) => set("groupId", groupId)}
            onCreateGroup={() => setCreateGroup(true)}
            value={values.groupId}
          />
          <div>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: linked to the Select via aria-labelledby on its trigger */}
            <label
              className="mb-1.5 block font-medium text-[13px]"
              id="monitor-method-label"
            >
              Method
            </label>
            <Select
              onValueChange={(value) => set("method", value)}
              value={values.method}
            >
              <SelectTrigger aria-labelledby="monitor-method-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["GET", "HEAD"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: linked to the Select via aria-labelledby on its trigger */}
            <label
              className="mb-1.5 block font-medium text-[13px]"
              id="monitor-interval-label"
            >
              Interval
            </label>
            <Select
              onValueChange={(value) => set("intervalMinutes", Number(value))}
              value={String(values.intervalMinutes)}
            >
              <SelectTrigger aria-labelledby="monitor-interval-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 5, 10, 15].map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value} min
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Collapsible
            className="-mx-6 border-[var(--border)] border-y px-6"
            onOpenChange={setAdvancedOpen}
            open={advancedOpen}
          >
            <CollapsibleTrigger className="group flex w-full items-center justify-between py-3 text-left font-medium text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              Advanced
              <ChevronDown
                aria-hidden
                className="size-4 text-[var(--fg-muted)] transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pb-4 transition-opacity duration-150">
              <NumberField
                error={errors.timeoutMs}
                label="Timeout ms"
                max={15_000}
                min={1000}
                onChange={(v) => set("timeoutMs", v)}
                value={values.timeoutMs}
              />
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  error={errors.expectedStatusMin}
                  label="Expected Status Min"
                  max={599}
                  min={100}
                  onChange={(v) => set("expectedStatusMin", v)}
                  value={values.expectedStatusMin}
                />
                <NumberField
                  error={errors.expectedStatusMax}
                  label="Expected Status Max"
                  max={599}
                  min={100}
                  onChange={(v) => set("expectedStatusMax", v)}
                  value={values.expectedStatusMax}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  error={errors.failureThreshold}
                  label="Failure Threshold"
                  max={5}
                  min={1}
                  onChange={(v) => set("failureThreshold", v)}
                  value={values.failureThreshold}
                />
                <NumberField
                  error={errors.recoveryThreshold}
                  label="Recovery Threshold"
                  max={5}
                  min={1}
                  onChange={(v) => set("recoveryThreshold", v)}
                  value={values.recoveryThreshold}
                />
              </div>
              <label className="block">
                <span className="mb-1.5 block font-medium text-[13px]">
                  Recipients
                </span>
                <textarea
                  aria-invalid={Boolean(errors.recipientsText)}
                  className="w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px]"
                  onChange={(e) => set("recipientsText", e.target.value)}
                  rows={4}
                  value={values.recipientsText}
                />
                <span className="mt-1 block text-[var(--fg-faint)] text-xs">
                  Empty inherits default recipients
                </span>
                {errors.recipientsText ? (
                  <span className="mt-1 block text-[var(--down-text)] text-xs">
                    {errors.recipientsText}
                  </span>
                ) : null}
              </label>
            </CollapsibleContent>
          </Collapsible>
          <label className="-mx-6 flex items-center justify-between gap-4 border-[var(--border)] border-y px-6 py-3 font-medium text-[13px]">
            <span>Enabled</span>
            <input
              checked={values.enabled}
              className="size-4 accent-[var(--fg)]"
              onChange={(e) => set("enabled", e.target.checked)}
              type="checkbox"
            />
          </label>
          <p aria-live="polite" className="sr-only" role="status">
            {status?.quiet ? status.message : null}
          </p>
          {status && !status.quiet ? (
            <p
              aria-live="polite"
              className={`text-[13px] ${status.error ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}
              role={status.error ? "alert" : "status"}
            >
              {status.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              disabled={Boolean(busy)}
              onClick={requestClose}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button disabled={Boolean(busy)} type="submit">
              {busy === "save"
                ? "Saving…"
                : busy === "propagation"
                  ? "Updating…"
                  : monitor
                    ? "Save Monitor"
                    : "Create Monitor"}
            </Button>
          </div>
        </form>
      </Sheet>
      {monitor && confirmArchive ? (
        <ArchiveDialog
          busy={Boolean(busy)}
          monitorName={monitor.name}
          onCancel={() => {
            setConfirmArchive(false)
            setArchiveName("")
          }}
          onConfirm={archive}
          onValueChange={setArchiveName}
          status={status}
          value={archiveName}
        />
      ) : null}
      <ConfirmDialog
        cancelLabel="Keep Editing"
        confirmLabel="Discard"
        destructive
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false)
          onClose()
        }}
        open={confirmDiscard}
        title={DISCARD_PROMPT}
      />
      {createGroup ? (
        <GroupDialog
          onClose={() => setCreateGroup(false)}
          onSaved={createdGroup}
          open
        />
      ) : null}
    </>
  )
}
