"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { GroupDialog } from "@/components/settings/group-dialog";
import { MonitorSheet, type EditableMonitor } from "@/components/settings/monitor-sheet";
import { apiRequest, groupDeleteBlockedCount, messageForError, sortSettingsGroups, type SettingsGroup } from "@/components/settings/settings-api";
import { CardHeading, SettingsRow } from "@/components/settings/settings-row";
import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export type MonitorSettingsData = {
  monitors: Array<EditableMonitor & { state: MonitorState }>;
  groups: SettingsGroup[];
  userAgent: string;
};

function monitorSummary(method: string, intervalMinutes: number, timeoutMs: number): string {
  const timeout = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
  return `${method} · ${intervalMinutes}m · ${timeout} timeout`;
}

export function MonitorsSettings({ data }: { data: MonitorSettingsData }) {
  const router = useRouter();
  const [monitorSheet, setMonitorSheet] = useState<EditableMonitor | "new" | null>(null);
  const [groups, setGroups] = useState(() => sortSettingsGroups(data.groups));
  const [groupDialog, setGroupDialog] = useState<SettingsGroup | "new" | null>(null);
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupStatus, setGroupStatus] = useState("");
  const [groupStatusError, setGroupStatusError] = useState(false);
  const [monitorBusy, setMonitorBusy] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState("");

  async function toggleMonitor(monitor: EditableMonitor) {
    const action = monitor.enabled ? "pause" : "resume";
    setMonitorBusy(monitor.id); setRowStatus("");
    try {
      await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}/${action}`, { method: "POST" }, true);
      setRowStatus(`${monitor.name} ${monitor.enabled ? "paused" : "resumed"}`); router.refresh();
    } catch (error) { setRowStatus(messageForError(error)); }
    finally { setMonitorBusy(null); }
  }

  function saveGroup(group: SettingsGroup) {
    setGroups((current) => sortSettingsGroups([
      ...current.filter((item) => item.id !== group.id),
      group,
    ]));
    setGroupDialog(null);
    setGroupStatus("");
    setGroupStatusError(false);
    router.refresh();
  }

  function updateGroupCounts(previousGroupId: string | null, nextGroupId: string | null) {
    if (previousGroupId === nextGroupId) return;
    setGroups((current) => current.map((group) => ({
      ...group,
      monitorCount: Math.max(0, group.monitorCount + (group.id === nextGroupId ? 1 : 0) - (group.id === previousGroupId ? 1 : 0)),
    })));
  }

  async function deleteGroup(group: SettingsGroup) {
    setGroupBusy(true);
    setGroupStatus("");
    setGroupStatusError(false);
    try {
      await apiRequest(`/api/v1/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" }, true);
      setGroups((current) => current.filter((item) => item.id !== group.id));
      setDeleteGroupId(null);
      setGroupStatus(`${group.name} deleted`);
      router.refresh();
    } catch (error) {
      const monitorCount = groupDeleteBlockedCount(error);
      if (monitorCount !== null) {
        setGroups((current) => current.map((item) => item.id === group.id ? { ...item, monitorCount } : item));
        setDeleteGroupId(null);
        setGroupStatus(`Move ${monitorCount} ${monitorCount === 1 ? "monitor" : "monitors"} before deleting ${group.name}`);
      } else {
        setGroupStatus(messageForError(error));
      }
      setGroupStatusError(true);
    } finally {
      setGroupBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeading title="Monitors" action={<Button variant="primary" size="sm" onClick={() => setMonitorSheet("new")}>New Monitor</Button>} />
        <div className="hide-scrollbar overflow-x-auto border-t border-[var(--border)]">
          <table className="w-full min-w-[460px] border-collapse text-left text-[13px] md:min-w-[660px]"><thead className="text-xs text-[var(--fg-muted)]"><tr className="h-10 border-b border-[var(--border)]"><th className="px-6 font-medium">Monitor</th><th className="px-4 font-medium max-md:hidden">Configuration</th><th className="px-4 font-medium max-lg:hidden">Group</th><th className="px-4 text-center font-medium">Enabled</th><th className="px-6 text-right font-medium"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{data.monitors.map((monitor) => <tr key={monitor.id} className="h-[60px] border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"><td className="px-6"><div className="flex min-w-0 items-center gap-2.5"><StatusDot state={monitor.state} /><div className="min-w-0"><p className="font-medium">{monitor.name}</p><div className="max-w-[360px] truncate font-data text-xs text-[var(--fg-faint)]">{monitor.url}</div></div></div></td><td className="px-4 font-data text-xs text-[var(--fg-muted)] max-md:hidden">{monitorSummary(monitor.method, monitor.intervalMinutes, monitor.timeoutMs)}</td><td className="px-4 text-xs text-[var(--fg-muted)] max-lg:hidden">{monitor.group ?? "Ungrouped"}</td><td className="px-4 text-center"><button type="button" role="switch" aria-checked={monitor.enabled} aria-label={`${monitor.enabled ? "Pause" : "Resume"} ${monitor.name}`} disabled={monitorBusy === monitor.id} onClick={() => toggleMonitor(monitor)} className={`relative h-5 w-9 rounded-full border border-[var(--border-strong)] ${monitor.enabled ? "bg-[var(--fg)]" : "bg-[var(--chip-bg)]"}`}><span aria-hidden="true" className={`absolute top-[3px] size-3 rounded-full ${monitor.enabled ? "left-[19px] bg-[var(--bg)]" : "left-[3px] bg-[var(--fg-muted)]"}`} /></button></td><td className="px-6 text-right"><div className="inline-flex items-center gap-1"><Link href={`/monitors/${encodeURIComponent(monitor.id)}`} className="inline-flex h-8 items-center rounded-[6px] px-2.5 text-[13px] font-medium text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]">View <span aria-hidden="true">→</span></Link><Button variant="secondary" size="sm" onClick={() => setMonitorSheet(monitor)}>Edit</Button></div></td></tr>)}</tbody></table>
          {data.monitors.length === 0 ? <div className="px-6 py-12 text-center"><p className="font-medium">No monitors configured</p><p className="mt-1 text-[13px] text-[var(--fg-muted)]">Create your first endpoint monitor</p></div> : null}
        </div>
        {rowStatus ? <p className="border-t border-[var(--border)] px-6 py-3 text-[13px] text-[var(--fg-muted)]" aria-live="polite">{rowStatus}</p> : null}
      </Card>

      <Card className="overflow-hidden">
        <CardHeading title="Groups" action={<Button variant="primary" size="sm" onClick={() => setGroupDialog("new")}>Create Group</Button>} />
        <div className="border-t border-[var(--border)]">
          {groups.map((group) => {
            const hasMonitors = group.monitorCount > 0;
            const confirmingDelete = deleteGroupId === group.id;
            return (
              <div key={group.id} className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-6 py-3 last:border-0">
                <div>
                  <p className="text-[13px] font-medium">{group.name}</p>
                  <p className="text-xs text-[var(--fg-muted)]">{group.monitorCount} {group.monitorCount === 1 ? "monitor" : "monitors"}</p>
                  {hasMonitors ? <p className="mt-1 text-xs text-[var(--fg-faint)]">Move monitors before deleting</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="tertiary" size="sm" onClick={() => setGroupDialog(group)} disabled={groupBusy}>Rename</Button>
                  {confirmingDelete ? <>
                    <span className="text-xs text-[var(--down-text)]">Delete?</span>
                    <Button variant="secondary" size="sm" onClick={() => setDeleteGroupId(null)} disabled={groupBusy}>Cancel</Button>
                    <Button variant="error-outline" size="sm" onClick={() => void deleteGroup(group)} disabled={groupBusy}>{groupBusy ? "Deleting…" : "Confirm"}</Button>
                  </> : <Button variant="error-outline" size="sm" onClick={() => setDeleteGroupId(group.id)} disabled={hasMonitors || groupBusy} title={hasMonitors ? "Move monitors before deleting this group" : undefined}>Delete</Button>}
                </div>
              </div>
            );
          })}
          {groups.length === 0 ? <div className="px-6 py-10 text-center"><p className="font-medium">No groups configured</p><p className="mt-1 text-[13px] text-[var(--fg-muted)]">Organize related endpoint monitors</p></div> : null}
        </div>
        {groupStatus ? <p aria-live="polite" className={`border-t border-[var(--border)] px-6 py-3 text-[13px] ${groupStatusError ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}>{groupStatus}</p> : null}
      </Card>

      <Card className="overflow-hidden">
        <CardHeading title="Defaults" />
        <div className="border-t border-[var(--border)]">
          <SettingsRow label="Check user agent" description="Sent with every monitor request. Allowlist it if your endpoints sit behind a firewall.">
            <span className="font-data text-[13px] text-[var(--fg-muted)]">{data.userAgent}</span>
          </SettingsRow>
        </div>
      </Card>

      {monitorSheet !== null ? <MonitorSheet key={monitorSheet === "new" ? "new" : monitorSheet.id} open monitor={monitorSheet === "new" ? null : monitorSheet} groups={groups} onGroupCreated={saveGroup} onMonitorGroupChanged={updateGroupCounts} onClose={() => setMonitorSheet(null)} /> : null}
      {groupDialog !== null ? <GroupDialog open group={groupDialog === "new" ? null : groupDialog} onClose={() => setGroupDialog(null)} onSaved={saveGroup} /> : null}
    </div>
  );
}
