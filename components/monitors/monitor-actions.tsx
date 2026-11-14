"use client"

import { Activity, Pause, Pencil, Play } from "lucide-react"
import { useRouter } from "next/navigation"
import { type ReactNode, useId, useState } from "react"
import type { EditableMonitor } from "@/components/monitors/monitor-form"
import { runMonitorTest } from "@/components/monitors/monitor-test"
import { MonitorSheet } from "@/components/settings/monitor-sheet"
import {
  type SettingsGroup,
  sortSettingsGroups,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"

export type { EditableMonitor } from "@/components/monitors/monitor-form"

type MutationState =
  | { status: "idle" }
  | { status: "loading"; message: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string }

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

// Detail page entry to the shared monitor sheet. Groups created from the sheet
// are held here so the new group is selectable before the server refresh.
// Mounted only while open, so each open starts from the server groups.
function DetailMonitorSheet({
  monitor,
  groups,
  onClose,
}: {
  monitor: EditableMonitor
  groups: readonly SettingsGroup[]
  onClose: () => void
}) {
  const router = useRouter()
  const [availableGroups, setAvailableGroups] = useState(() =>
    sortSettingsGroups(groups)
  )

  return (
    <MonitorSheet
      groups={availableGroups}
      monitor={monitor}
      onArchived={() => router.push("/")}
      onClose={onClose}
      onGroupCreated={(group) =>
        setAvailableGroups((current) =>
          sortSettingsGroups([
            ...current.filter((item) => item.id !== group.id),
            group,
          ])
        )
      }
      open
    />
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
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: focusable wrapper surfaces the disabled reason when the inner button cannot take focus
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

export function MonitorActions({
  canManageMonitors,
  monitor,
  groups,
}: {
  canManageMonitors: boolean
  monitor: EditableMonitor
  groups: readonly SettingsGroup[]
}) {
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [action, setAction] = useState<MutationState>({ status: "idle" })

  async function runTest() {
    setAction({ status: "loading", message: "Checking…" })
    const outcome = await runMonitorTest(monitor.id)
    setAction(outcome)
    if (outcome.status === "success") {
      router.refresh()
    }
  }

  async function runToggle(kind: "pause" | "resume") {
    setAction({
      status: "loading",
      message: kind === "pause" ? "Pausing…" : "Resuming…",
    })
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
      setAction({
        status: "success",
        message: kind === "pause" ? "Monitor paused" : "Monitor resumed",
      })
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

  if (!canManageMonitors) {
    return null
  }

  return (
    <>
      <div className="relative flex flex-wrap gap-2">
        <HeaderIconAction
          disabled={isBusy || paused}
          disabledDescription={
            paused
              ? "Resume this monitor to run a test"
              : "Another monitor action is in progress"
          }
          label="Test Monitor"
          onClick={() => void runTest()}
        >
          <Activity aria-hidden className="size-4" />
        </HeaderIconAction>
        <HeaderIconAction
          disabled={isBusy}
          disabledDescription="Another monitor action is in progress"
          label={paused ? "Resume Monitor" : "Pause Monitor"}
          onClick={() => void runToggle(paused ? "resume" : "pause")}
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
        {/* Absolutely positioned so the status text never shifts the buttons above it */}
        <div className="absolute top-full left-0 pt-2">
          <MutationMessage state={action} />
        </div>
      </div>
      {editOpen ? (
        <DetailMonitorSheet
          groups={groups}
          monitor={monitor}
          onClose={() => setEditOpen(false)}
        />
      ) : null}
    </>
  )
}

export function MonitorSetupActions({
  canManageMonitors,
  groups,
  monitor,
}: {
  canManageMonitors: boolean
  groups: readonly SettingsGroup[]
  monitor: EditableMonitor
}) {
  if (!canManageMonitors) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <MonitorRunTestButton monitor={monitor} />
      <MonitorEditButton
        canManageMonitors={canManageMonitors}
        groups={groups}
        monitor={monitor}
      />
    </div>
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
    const outcome = await runMonitorTest(monitor.id)
    setState(outcome)
    if (outcome.status === "success") {
      router.refresh()
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

export function MonitorEditButton({
  canManageMonitors,
  monitor,
  groups,
}: {
  canManageMonitors: boolean
  monitor: EditableMonitor
  groups: readonly SettingsGroup[]
}) {
  const [open, setOpen] = useState(false)

  if (!canManageMonitors) {
    return null
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="tertiary">
        Edit Monitor
      </Button>
      {open ? (
        <DetailMonitorSheet
          groups={groups}
          monitor={monitor}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
