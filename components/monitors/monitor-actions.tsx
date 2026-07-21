"use client"

import {
  Activity,
  Archive,
  ChevronDown,
  Pause,
  Pencil,
  Play,
  X,
} from "lucide-react"
import { useRouter } from "next/navigation"
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { isPublicHttpUrl } from "@/lib/net/public-url"

export interface EditableMonitor {
  id: string
  name: string
  url: string
  group: string | null
  method: string
  enabled: boolean
  intervalMinutes: number
  timeoutMs: number
  expectedStatusMin: number
  expectedStatusMax: number
  failureThreshold: number
  recoveryThreshold: number
  recipients: string[]
}

type MutationState =
  | { status: "idle" }
  | { status: "loading"; message: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string }

export interface MonitorEditValues {
  name: string
  url: string
  group: string
  method: "GET" | "HEAD"
  intervalMinutes: string
  timeoutMs: string
  expectedStatusMin: string
  expectedStatusMax: string
  failureThreshold: string
  recoveryThreshold: string
  recipients: string
  enabled: boolean
}

export type MonitorEditErrors = Partial<Record<keyof MonitorEditValues, string>>

const advancedMonitorEditFields = [
  "timeoutMs",
  "expectedStatusMin",
  "expectedStatusMax",
  "failureThreshold",
  "recoveryThreshold",
  "recipients",
] as const

export function hasAdvancedMonitorEditErrors(
  errors: MonitorEditErrors
): boolean {
  return advancedMonitorEditFields.some((field) => Boolean(errors[field]))
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function initialValues(monitor: EditableMonitor): MonitorEditValues {
  return {
    name: monitor.name,
    url: monitor.url,
    group: monitor.group ?? "",
    method: monitor.method === "HEAD" ? "HEAD" : "GET",
    intervalMinutes: String(monitor.intervalMinutes),
    timeoutMs: String(monitor.timeoutMs),
    expectedStatusMin: String(monitor.expectedStatusMin),
    expectedStatusMax: String(monitor.expectedStatusMax),
    failureThreshold: String(monitor.failureThreshold),
    recoveryThreshold: String(monitor.recoveryThreshold),
    recipients: monitor.recipients.join("\n"),
    enabled: monitor.enabled,
  }
}

export function validateMonitorEdit(
  values: MonitorEditValues
): MonitorEditErrors {
  const errors: MonitorEditErrors = {}
  const name = values.name.trim()
  const group = values.group.trim()
  const recipients = values.recipients
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)

  if (!name) {
    errors.name = "Enter a monitor name"
  } else if (name.length > 80) {
    errors.name = "Use 80 characters or fewer"
  }

  if (!isPublicHttpUrl(values.url)) {
    errors.url = "Enter a public HTTP or HTTPS URL"
  }

  if (group.length > 50) {
    errors.group = "Use 50 characters or fewer"
  }
  if (!["1", "5", "10", "15"].includes(values.intervalMinutes)) {
    errors.intervalMinutes = "Choose 1, 5, 10, or 15 minutes"
  }

  validateInteger(
    values.timeoutMs,
    1000,
    15_000,
    "Use 1000–15000 ms",
    "timeoutMs",
    errors
  )
  validateInteger(
    values.expectedStatusMin,
    100,
    599,
    "Use a status from 100–599",
    "expectedStatusMin",
    errors
  )
  validateInteger(
    values.expectedStatusMax,
    100,
    599,
    "Use a status from 100–599",
    "expectedStatusMax",
    errors
  )
  if (
    !(errors.expectedStatusMin || errors.expectedStatusMax) &&
    Number(values.expectedStatusMax) < Number(values.expectedStatusMin)
  ) {
    errors.expectedStatusMax = "Maximum must be at least the minimum"
  }
  validateInteger(
    values.failureThreshold,
    1,
    5,
    "Use a threshold from 1–5",
    "failureThreshold",
    errors
  )
  validateInteger(
    values.recoveryThreshold,
    1,
    5,
    "Use a threshold from 1–5",
    "recoveryThreshold",
    errors
  )

  if (recipients.length > 20) {
    errors.recipients = "Use no more than 20 recipients"
  } else if (recipients.some((recipient) => !emailPattern.test(recipient))) {
    errors.recipients = "Enter one valid email per line"
  } else if (
    new Set(recipients.map((recipient) => recipient.toLowerCase())).size !==
    recipients.length
  ) {
    errors.recipients = "Remove duplicate recipients"
  }

  return errors
}

function validateInteger(
  value: string,
  minimum: number,
  maximum: number,
  message: string,
  field: keyof MonitorEditValues,
  errors: MonitorEditErrors
) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    errors[field] = message
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    return body.error?.message ?? "The request could not be completed"
  } catch {
    return "The request could not be completed"
  }
}

async function mutateMonitor(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      ...init.headers,
    },
  })
}

function ModalFrame({
  children,
  labelledBy,
  onClose,
  panelClassName,
}: {
  children: ReactNode
  labelledBy: string
  onClose: () => void
  panelClassName: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    document.body.style.overflow = "hidden"
    const autofocusTarget =
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")
    ;(autofocusTarget ?? panelRef.current)?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== "Tab") {
      return
    }
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )
    if (!focusable?.length) {
      return
    }
    const first = focusable[0]
    // biome-ignore lint/style/useAtIndex: NodeListOf has no .at in the DOM lib
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={panelClassName}
        onKeyDown={handleKeyDown}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  )
}

function MutationMessage({ state }: { state: MutationState }) {
  if (state.status === "idle") {
    return null
  }
  return (
    <p
      aria-live="polite"
      className={
        state.status === "error"
          ? "text-[var(--down-text)] text-xs"
          : "text-[var(--fg-muted)] text-xs"
      }
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  )
}

function HeaderIconAction({
  label,
  disabled,
  disabledDescription,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  disabledDescription?: string
  onClick: () => void
  children: ReactNode
}) {
  const tooltipId = useId()

  return (
    <span
      aria-label={
        disabled && disabledDescription
          ? `${label}. ${disabledDescription}`
          : undefined
      }
      className="group relative inline-flex"
      tabIndex={disabled ? 0 : undefined}
    >
      <Button
        aria-describedby={tooltipId}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        size="icon-sm"
        variant="tertiary"
      >
        {children}
      </Button>
      <span
        className="pointer-events-none absolute top-[calc(100%+8px)] left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 font-medium text-[var(--fg)] text-xs opacity-0 shadow-[var(--popover-shadow)] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
        id={tooltipId}
        role="tooltip"
      >
        {label}
      </span>
    </span>
  )
}

export function MonitorActions({ monitor }: { monitor: EditableMonitor }) {
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [action, setAction] = useState<MutationState>({ status: "idle" })

  async function runAction(kind: "test" | "pause" | "resume") {
    const present =
      kind === "test"
        ? "Checking…"
        : kind === "pause"
          ? "Pausing…"
          : "Resuming…"
    const complete =
      kind === "test"
        ? "Monitor check complete"
        : kind === "pause"
          ? "Monitor paused"
          : "Monitor resumed"
    setAction({ status: "loading", message: present })
    try {
      const response = await mutateMonitor(
        `/api/v1/monitors/${encodeURIComponent(monitor.id)}/${kind}`,
        { method: "POST" }
      )
      if (!response.ok) {
        setAction({
          status: "error",
          message:
            response.status === 409
              ? "Configuration changed elsewhere. Reload before trying again."
              : await readError(response),
        })
        return
      }
      setAction({ status: "success", message: complete })
      router.refresh()
    } catch {
      setAction({
        status: "error",
        message: "Unable to reach the server. Try again.",
      })
    }
  }

  const isBusy = action.status === "loading"
  const paused = !monitor.enabled

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <div className="flex flex-wrap gap-2">
          <HeaderIconAction
            disabled={isBusy || paused}
            disabledDescription={
              paused
                ? "Resume this monitor to run a test"
                : "Another monitor action is in progress"
            }
            label="Test Monitor"
            onClick={() => void runAction("test")}
          >
            <Activity aria-hidden className="size-4" />
          </HeaderIconAction>
          <HeaderIconAction
            disabled={isBusy}
            disabledDescription="Another monitor action is in progress"
            label={paused ? "Resume Monitor" : "Pause Monitor"}
            onClick={() => void runAction(paused ? "resume" : "pause")}
          >
            {paused ? (
              <Play aria-hidden className="size-4" />
            ) : (
              <Pause aria-hidden className="size-4" />
            )}
          </HeaderIconAction>
          <HeaderIconAction
            disabled={isBusy}
            disabledDescription="Another monitor action is in progress"
            label="Edit Monitor"
            onClick={() => setEditOpen(true)}
          >
            <Pencil aria-hidden className="size-4" />
          </HeaderIconAction>
        </div>
        <MutationMessage state={action} />
      </div>
      {editOpen ? (
        <MonitorEditSheet
          monitor={monitor}
          onArchived={() => router.push("/")}
          onClose={() => setEditOpen(false)}
        />
      ) : null}
    </>
  )
}

export function MonitorRunTestButton({
  monitor,
}: {
  monitor: EditableMonitor
}) {
  const router = useRouter()
  const [state, setState] = useState<MutationState>({ status: "idle" })
  const disabled = state.status === "loading" || !monitor.enabled

  async function runTest() {
    setState({ status: "loading", message: "Checking…" })
    try {
      const response = await mutateMonitor(
        `/api/v1/monitors/${encodeURIComponent(monitor.id)}/test`,
        { method: "POST" }
      )
      if (!response.ok) {
        setState({ status: "error", message: await readError(response) })
        return
      }
      // A completed probe can still fail. The endpoint reports that in the
      // successful flag, so a failed check reads as a failure, not success.
      const body = (await response.json()) as {
        data?: {
          successful?: boolean
          statusCode?: number | null
          errorCode?: string | null
        }
      }
      if (body.data?.successful !== true) {
        const detail =
          body.data?.statusCode == null
            ? (body.data?.errorCode ?? "Unknown failure")
            : `HTTP ${body.data.statusCode}`
        setState({
          status: "error",
          message: `Monitor check failed with ${detail}`,
        })
        return
      }
      setState({ status: "success", message: "Monitor check complete" })
      router.refresh()
    } catch {
      setState({
        status: "error",
        message: "Unable to reach the server. Try again.",
      })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={disabled}
        onClick={() => void runTest()}
        size="sm"
        variant="secondary"
      >
        Run Test
      </Button>
      <MutationMessage state={state} />
    </div>
  )
}

export function MonitorEditButton({ monitor }: { monitor: EditableMonitor }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="tertiary">
        Edit Monitor
      </Button>
      {open ? (
        <MonitorEditSheet
          monitor={monitor}
          onArchived={() => router.push("/")}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function MonitorEditSheet({
  monitor,
  onClose,
  onArchived,
}: {
  monitor: EditableMonitor
  onClose: () => void
  onArchived: () => void
}) {
  const router = useRouter()
  const titleId = useId()
  const [values, setValues] = useState(() => initialValues(monitor))
  const [errors, setErrors] = useState<MonitorEditErrors>({})
  const [state, setState] = useState<MutationState>({ status: "idle" })
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current)
      }
    },
    []
  )

  function update<K extends keyof MonitorEditValues>(
    key: K,
    value: MonitorEditValues[K]
  ) {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = validateMonitorEdit(values)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      if (hasAdvancedMonitorEditErrors(nextErrors)) {
        setAdvancedOpen(true)
      }
      setState({ status: "error", message: "Fix the highlighted fields" })
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          formRef.current
            ?.querySelector<HTMLElement>("[aria-invalid='true']")
            ?.focus()
        )
      )
      return
    }
    setState({ status: "loading", message: "Saving…" })
    const recipients = values.recipients
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
    try {
      const response = await mutateMonitor(
        `/api/v1/monitors/${encodeURIComponent(monitor.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: values.name.trim(),
            url: values.url,
            group: values.group.trim() || null,
            method: values.method,
            intervalMinutes: Number(values.intervalMinutes),
            timeoutMs: Number(values.timeoutMs),
            expectedStatus: {
              minimum: Number(values.expectedStatusMin),
              maximum: Number(values.expectedStatusMax),
            },
            failureThreshold: Number(values.failureThreshold),
            recoveryThreshold: Number(values.recoveryThreshold),
            recipients,
            enabled: values.enabled,
          }),
        }
      )
      if (!response.ok) {
        setState({
          status: "error",
          message:
            response.status === 409
              ? "Configuration changed elsewhere. Reload before saving."
              : await readError(response),
        })
        return
      }
      setState({ status: "success", message: "Updating configuration…" })
      refreshTimer.current = setTimeout(() => {
        router.refresh()
        onClose()
      }, 10_000)
    } catch {
      setState({
        status: "error",
        message: "Unable to reach the server. Try again.",
      })
    }
  }

  const busy = state.status === "loading" || state.status === "success"
  return (
    <>
      <ModalFrame
        labelledBy={titleId}
        onClose={busy ? () => undefined : onClose}
        panelClassName="ml-auto flex h-full w-[min(480px,100vw)] flex-col border-l border-[var(--border-strong)] bg-[var(--bg)] shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between border-[var(--border)] border-b px-6 py-4">
          <h2 className="font-semibold text-sm" id={titleId}>
            Edit Monitor
          </h2>
          <Button
            aria-label="Close edit monitor"
            disabled={busy}
            onClick={onClose}
            size="icon-sm"
            variant="tertiary"
          >
            <X className="size-4" />
          </Button>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={submit}
          ref={formRef}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <TextField
              autoFocus
              data-autofocus
              error={errors.name}
              id="monitor-name"
              label="Name"
              onChange={(value) => update("name", value)}
              value={values.name}
            />
            <TextField
              className="font-data"
              error={errors.url}
              id="monitor-url"
              label="URL"
              onChange={(value) => update("url", value)}
              value={values.url}
            />
            <TextField
              error={errors.group}
              id="monitor-group"
              label="Group"
              onChange={(value) => update("group", value)}
              value={values.group}
            />
            <SelectField
              id="monitor-method"
              label="Method"
              onChange={(value) => update("method", value as "GET" | "HEAD")}
              options={["GET", "HEAD"]}
              value={values.method}
            />
            <SelectField
              error={errors.intervalMinutes}
              id="monitor-interval"
              label="Interval"
              onChange={(value) => update("intervalMinutes", value)}
              options={["1", "5", "10", "15"]}
              renderLabel={(value) => `${value} min`}
              value={values.intervalMinutes}
            />
            <Collapsible
              className="border-[var(--border)] border-y"
              onOpenChange={setAdvancedOpen}
              open={advancedOpen}
            >
              <CollapsibleTrigger className="group flex w-full items-center justify-between py-3 text-left font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                Advanced
                <ChevronDown
                  aria-hidden
                  className="size-4 text-[var(--fg-muted)] transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-5 pb-5 transition-opacity duration-150">
                <TextField
                  className="font-data"
                  error={errors.timeoutMs}
                  id="monitor-timeout"
                  label="Timeout ms"
                  max={15_000}
                  min={1000}
                  onChange={(value) => update("timeoutMs", value)}
                  type="number"
                  value={values.timeoutMs}
                />
                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    className="font-data"
                    error={errors.expectedStatusMin}
                    id="monitor-status-min"
                    label="Expected Status Min"
                    max={599}
                    min={100}
                    onChange={(value) => update("expectedStatusMin", value)}
                    type="number"
                    value={values.expectedStatusMin}
                  />
                  <TextField
                    className="font-data"
                    error={errors.expectedStatusMax}
                    id="monitor-status-max"
                    label="Expected Status Max"
                    max={599}
                    min={100}
                    onChange={(value) => update("expectedStatusMax", value)}
                    type="number"
                    value={values.expectedStatusMax}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    className="font-data"
                    error={errors.failureThreshold}
                    id="monitor-failure-threshold"
                    label="Failure Threshold"
                    max={5}
                    min={1}
                    onChange={(value) => update("failureThreshold", value)}
                    type="number"
                    value={values.failureThreshold}
                  />
                  <TextField
                    className="font-data"
                    error={errors.recoveryThreshold}
                    id="monitor-recovery-threshold"
                    label="Recovery Threshold"
                    max={5}
                    min={1}
                    onChange={(value) => update("recoveryThreshold", value)}
                    type="number"
                    value={values.recoveryThreshold}
                  />
                </div>
                <Field
                  description="Empty inherits default recipients"
                  error={errors.recipients}
                  htmlFor="monitor-recipients"
                  label="Recipients"
                >
                  <textarea
                    aria-invalid={Boolean(errors.recipients)}
                    className="w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-sm outline-none hover:border-[var(--border-hover)] aria-invalid:border-[var(--down-text)]"
                    id="monitor-recipients"
                    onChange={(event) =>
                      update("recipients", event.target.value)
                    }
                    rows={5}
                    value={values.recipients}
                  />
                </Field>
              </CollapsibleContent>
            </Collapsible>
            <label className="flex items-center justify-between gap-4 font-medium text-sm">
              Enabled
              <input
                checked={values.enabled}
                className="size-4 accent-[var(--fg)]"
                onChange={(event) => update("enabled", event.target.checked)}
                type="checkbox"
              />
            </label>
            <MutationMessage state={state} />
          </div>
          <div className="flex items-center justify-between gap-3 border-[var(--border)] border-t px-6 py-4">
            <Button
              disabled={busy}
              onClick={() => setArchiveOpen(true)}
              type="button"
              variant="secondary"
            >
              <Archive className="size-4" />
              Archive Monitor
            </Button>
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={onClose}
                type="button"
                variant="secondary"
              >
                Cancel
              </Button>
              <Button disabled={busy} type="submit">
                {state.status === "loading"
                  ? "Saving…"
                  : state.status === "success"
                    ? "Updating…"
                    : "Save Monitor"}
              </Button>
            </div>
          </div>
        </form>
      </ModalFrame>
      {archiveOpen ? (
        <ArchiveDialog
          monitor={monitor}
          onArchived={onArchived}
          onClose={() => setArchiveOpen(false)}
        />
      ) : null}
    </>
  )
}

function ArchiveDialog({
  monitor,
  onClose,
  onArchived,
}: {
  monitor: EditableMonitor
  onClose: () => void
  onArchived: () => void
}) {
  const titleId = useId()
  const [confirmation, setConfirmation] = useState("")
  const [state, setState] = useState<MutationState>({ status: "idle" })
  const navigationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const matches = confirmation === monitor.name

  useEffect(
    () => () => {
      if (navigationTimer.current) {
        clearTimeout(navigationTimer.current)
      }
    },
    []
  )

  async function archive() {
    setState({ status: "loading", message: "Archiving…" })
    try {
      const response = await mutateMonitor(
        `/api/v1/monitors/${encodeURIComponent(monitor.id)}`,
        { method: "DELETE" }
      )
      if (!response.ok) {
        setState({
          status: "error",
          message:
            response.status === 409
              ? "Configuration changed elsewhere. Reload before archiving."
              : await readError(response),
        })
        return
      }
      setState({ status: "success", message: "Monitor archived" })
      navigationTimer.current = setTimeout(onArchived, 800)
    } catch {
      setState({
        status: "error",
        message: "Unable to reach the server. Try again.",
      })
    }
  }

  return (
    <ModalFrame
      labelledBy={titleId}
      onClose={
        state.status === "idle" || state.status === "error"
          ? onClose
          : () => undefined
      }
      panelClassName="m-auto w-[min(420px,calc(100vw-32px))] rounded-xl border border-[var(--border-strong)] bg-[var(--bg)] p-6 shadow-2xl outline-none"
    >
      <h2 className="font-semibold text-sm" id={titleId}>
        Archive Monitor
      </h2>
      <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
        Archive removes this monitor from active monitoring. Type{" "}
        <span className="font-data text-[var(--fg)]">{monitor.name}</span> to
        continue.
      </p>
      <Field
        className="mt-5"
        htmlFor="archive-monitor-name"
        label="Monitor Name"
      >
        <Input
          autoComplete="off"
          autoFocus
          data-autofocus
          id="archive-monitor-name"
          onChange={(event) => setConfirmation(event.target.value)}
          value={confirmation}
        />
      </Field>
      <div className="mt-3">
        <MutationMessage state={state} />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button
          disabled={state.status === "loading" || state.status === "success"}
          onClick={onClose}
          variant="tertiary"
        >
          Cancel
        </Button>
        <Button
          disabled={
            !matches || state.status === "loading" || state.status === "success"
          }
          onClick={() => void archive()}
          variant="secondary"
        >
          {state.status === "loading"
            ? "Archiving…"
            : state.status === "success"
              ? "Archived"
              : "Archive Monitor"}
        </Button>
      </div>
    </ModalFrame>
  )
}

function TextField({
  id,
  label,
  error,
  onChange,
  className,
  ...props
}: {
  id: string
  label: string
  error?: string
  onChange: (value: string) => void
  className?: string
} & Omit<React.ComponentProps<typeof Input>, "id" | "onChange">) {
  return (
    <Field error={error} htmlFor={id} label={label}>
      <Input
        id={id}
        {...props}
        aria-invalid={Boolean(error)}
        className={className}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  renderLabel = (option) => option,
  error,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
  renderLabel?: (value: string) => string
  error?: string
}) {
  return (
    <Field error={error} htmlFor={id} label={label}>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger
          aria-invalid={Boolean(error)}
          className="aria-invalid:border-[var(--down-text)]"
          id={id}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {renderLabel(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
