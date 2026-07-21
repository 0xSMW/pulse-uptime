"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  StatusDot,
  type VisibleMonitorState,
} from "@/components/monitors/status-dot"
import { GroupDialog } from "@/components/settings/group-dialog"
import {
  type EditableMonitor,
  MonitorSheet,
} from "@/components/settings/monitor-sheet"
import {
  apiRequest,
  groupDeleteBlockedCount,
  messageForError,
  type SettingsGroup,
  sortSettingsGroups,
} from "@/components/settings/settings-api"
import { CardHeading, SettingsRow } from "@/components/settings/settings-row"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { isPlainLeftClick, navigateRow } from "@/components/ui/row-navigation"

export interface MonitorSettingsData {
  monitors: Array<EditableMonitor & { state: VisibleMonitorState }>
  groups: SettingsGroup[]
  userAgent: string
}

function monitorSummary(
  method: string,
  intervalMinutes: number,
  timeoutMs: number
): string {
  const timeout =
    timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`
  return `${method} · ${intervalMinutes}m · ${timeout} timeout`
}

export function MonitorsSettings({ data }: { data: MonitorSettingsData }) {
  const router = useRouter()
  const [monitorSheet, setMonitorSheet] = useState<
    EditableMonitor | "new" | null
  >(null)
  // data.groups stays authoritative. The sorted list is optimistic overlay
  // state so mutations can reflect instantly, but it resets to the server
  // value whenever data.groups changes, so a router.refresh() from any path
  // (including this component's own handlers) never leaves it stale.
  const serverGroups = sortSettingsGroups(data.groups)
  const [groups, setGroups] = useState(serverGroups)
  const [groupsSource, setGroupsSource] = useState(data.groups)
  if (groupsSource !== data.groups) {
    setGroupsSource(data.groups)
    setGroups(serverGroups)
  }
  const [groupDialog, setGroupDialog] = useState<SettingsGroup | "new" | null>(
    null
  )
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupStatus, setGroupStatus] = useState("")
  const [groupStatusError, setGroupStatusError] = useState(false)
  const [monitorBusy, setMonitorBusy] = useState<string | null>(null)
  const [rowStatus, setRowStatus] = useState("")

  async function toggleMonitor(monitor: EditableMonitor) {
    const action = monitor.enabled ? "pause" : "resume"
    setMonitorBusy(monitor.id)
    setRowStatus("")
    try {
      await apiRequest(
        `/api/v1/monitors/${encodeURIComponent(monitor.id)}/${action}`,
        { method: "POST" },
        true
      )
      setRowStatus(`${monitor.name} ${monitor.enabled ? "paused" : "resumed"}`)
      router.refresh()
    } catch (error) {
      setRowStatus(messageForError(error))
    } finally {
      setMonitorBusy(null)
    }
  }

  function saveGroup(group: SettingsGroup) {
    setGroups((current) =>
      sortSettingsGroups([
        ...current.filter((item) => item.id !== group.id),
        group,
      ])
    )
    setGroupDialog(null)
    setGroupStatus("")
    setGroupStatusError(false)
    router.refresh()
  }

  function updateGroupCounts(
    previousGroupId: string | null,
    nextGroupId: string | null
  ) {
    if (previousGroupId === nextGroupId) {
      return
    }
    setGroups((current) =>
      current.map((group) => ({
        ...group,
        monitorCount: Math.max(
          0,
          group.monitorCount +
            (group.id === nextGroupId ? 1 : 0) -
            (group.id === previousGroupId ? 1 : 0)
        ),
      }))
    )
  }

  async function deleteGroup(group: SettingsGroup) {
    setGroupBusy(true)
    setGroupStatus("")
    setGroupStatusError(false)
    try {
      await apiRequest(
        `/api/v1/groups/${encodeURIComponent(group.id)}`,
        { method: "DELETE" },
        true
      )
      setGroups((current) => current.filter((item) => item.id !== group.id))
      setDeleteGroupId(null)
      setGroupStatus(`${group.name} deleted`)
      router.refresh()
    } catch (error) {
      const monitorCount = groupDeleteBlockedCount(error)
      if (monitorCount === null) {
        setGroupStatus(messageForError(error))
      } else {
        setGroups((current) =>
          current.map((item) =>
            item.id === group.id ? { ...item, monitorCount } : item
          )
        )
        setDeleteGroupId(null)
        setGroupStatus(
          `Move ${monitorCount} ${monitorCount === 1 ? "monitor" : "monitors"} before deleting ${group.name}`
        )
      }
      setGroupStatusError(true)
    } finally {
      setGroupBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeading
          action={
            <Button
              onClick={() => setMonitorSheet("new")}
              size="sm"
              variant="primary"
            >
              New Monitor
            </Button>
          }
          title="Monitors"
        />
        <div className="hide-scrollbar overflow-x-auto border-[var(--border)] border-t">
          <table className="w-full min-w-[460px] border-collapse text-left text-[13px] md:min-w-[660px]">
            <thead className="text-[var(--fg-muted)] text-xs">
              <tr className="h-10 border-[var(--border)] border-b">
                <th className="px-6 font-medium">Monitor</th>
                <th className="px-4 font-medium max-md:hidden">
                  Configuration
                </th>
                <th className="px-4 font-medium max-lg:hidden">Group</th>
                <th className="px-6 text-center font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {data.monitors.map((monitor) => (
                <tr
                  className="h-[60px] cursor-pointer border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                  key={monitor.id}
                  // The whole row opens the edit sheet. navigateRow supplies
                  // the nested-control guard, its href argument is unused here.
                  onClick={(event) => {
                    if (!isPlainLeftClick(event)) {
                      return
                    }
                    navigateRow(event.target, monitor.id, () =>
                      setMonitorSheet(monitor)
                    )
                  }}
                >
                  <td className="px-6">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <StatusDot state={monitor.state} />
                      <div className="min-w-0">
                        <button
                          aria-label={`Edit ${monitor.name}`}
                          className="block text-left font-medium"
                          onClick={() => setMonitorSheet(monitor)}
                          type="button"
                        >
                          {monitor.name}
                        </button>
                        <div className="max-w-[360px] truncate font-data text-[var(--fg-faint)] text-xs">
                          {monitor.url}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs max-md:hidden">
                    {monitorSummary(
                      monitor.method,
                      monitor.intervalMinutes,
                      monitor.timeoutMs
                    )}
                  </td>
                  <td className="px-4 text-[var(--fg-muted)] text-xs max-lg:hidden">
                    {monitor.group ?? "Ungrouped"}
                  </td>
                  <td className="px-6 text-center">
                    <button
                      aria-checked={monitor.enabled}
                      aria-label={`${monitor.enabled ? "Pause" : "Resume"} ${monitor.name}`}
                      className={`relative h-5 w-9 rounded-full border border-[var(--border-strong)] ${monitor.enabled ? "bg-[var(--fg)]" : "bg-[var(--chip-bg)]"}`}
                      disabled={monitorBusy === monitor.id}
                      onClick={() => toggleMonitor(monitor)}
                      role="switch"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute top-[3px] size-3 rounded-full ${monitor.enabled ? "left-[19px] bg-[var(--bg)]" : "left-[3px] bg-[var(--fg-muted)]"}`}
                      />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.monitors.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="font-medium">No monitors configured</p>
              <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
                Create your first endpoint monitor
              </p>
            </div>
          ) : null}
        </div>
        {rowStatus ? (
          <p
            aria-live="polite"
            className="border-[var(--border)] border-t px-6 py-3 text-[13px] text-[var(--fg-muted)]"
          >
            {rowStatus}
          </p>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <CardHeading
          action={
            <Button
              onClick={() => setGroupDialog("new")}
              size="sm"
              variant="primary"
            >
              Create Group
            </Button>
          }
          title="Groups"
        />
        <div className="border-[var(--border)] border-t">
          {groups.map((group) => {
            const hasMonitors = group.monitorCount > 0
            const confirmingDelete = deleteGroupId === group.id
            return (
              <div
                className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-[var(--border)] border-b px-6 py-3 last:border-0"
                key={group.id}
              >
                <div>
                  <p className="font-medium text-[13px]">{group.name}</p>
                  <p className="text-[var(--fg-muted)] text-xs">
                    {group.monitorCount}{" "}
                    {group.monitorCount === 1 ? "monitor" : "monitors"}
                  </p>
                  {hasMonitors ? (
                    <p className="mt-1 text-[var(--fg-faint)] text-xs">
                      Move monitors before deleting
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    disabled={groupBusy}
                    onClick={() => setGroupDialog(group)}
                    size="sm"
                    variant="tertiary"
                  >
                    Rename
                  </Button>
                  {confirmingDelete ? (
                    <>
                      <span className="text-[var(--down-text)] text-xs">
                        Delete?
                      </span>
                      <Button
                        disabled={groupBusy}
                        onClick={() => setDeleteGroupId(null)}
                        size="sm"
                        variant="secondary"
                      >
                        Cancel
                      </Button>
                      <Button
                        disabled={groupBusy}
                        onClick={() => void deleteGroup(group)}
                        size="sm"
                        variant="error-outline"
                      >
                        {groupBusy ? "Deleting…" : "Confirm"}
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={hasMonitors || groupBusy}
                      onClick={() => setDeleteGroupId(group.id)}
                      size="sm"
                      title={
                        hasMonitors
                          ? "Move monitors before deleting this group"
                          : undefined
                      }
                      variant="error-outline"
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
          {groups.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="font-medium">No groups configured</p>
              <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
                Organize related endpoint monitors
              </p>
            </div>
          ) : null}
        </div>
        {groupStatus ? (
          <p
            aria-live="polite"
            className={`border-[var(--border)] border-t px-6 py-3 text-[13px] ${groupStatusError ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}
          >
            {groupStatus}
          </p>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <CardHeading title="Defaults" />
        <div className="border-[var(--border)] border-t">
          <SettingsRow
            description="Sent with every monitor request. Allowlist it if your endpoints sit behind a firewall."
            label="Check user agent"
          >
            <span className="font-data text-[13px] text-[var(--fg-muted)]">
              {data.userAgent}
            </span>
          </SettingsRow>
        </div>
      </Card>

      {monitorSheet === null ? null : (
        <MonitorSheet
          groups={groups}
          key={monitorSheet === "new" ? "new" : monitorSheet.id}
          monitor={monitorSheet === "new" ? null : monitorSheet}
          onClose={() => setMonitorSheet(null)}
          onGroupCreated={saveGroup}
          onMonitorGroupChanged={updateGroupCounts}
          open
        />
      )}
      {groupDialog === null ? null : (
        <GroupDialog
          group={groupDialog === "new" ? null : groupDialog}
          onClose={() => setGroupDialog(null)}
          onSaved={saveGroup}
          open
        />
      )}
    </div>
  )
}
