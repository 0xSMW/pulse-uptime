"use client";

import { useState } from "react";

import { MonitorSheet } from "@/components/settings/monitor-sheet";
import { apiRequest, messageForError, sortSettingsGroups, type ApiEnvelope, type SettingsGroup } from "@/components/settings/settings-api";
import { Button } from "@/components/ui/button";

export function NewMonitorAction() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [status, setStatus] = useState("");

  async function openSheet() {
    setLoading(true);
    setStatus("");
    try {
      const response = await apiRequest<ApiEnvelope<SettingsGroup[]>>("/api/v1/groups");
      setGroups(sortSettingsGroups(response.data));
      setOpen(true);
    } catch (error) {
      setStatus(messageForError(error));
    } finally {
      setLoading(false);
    }
  }

  function addGroup(group: SettingsGroup) {
    setGroups((current) => sortSettingsGroups([...current.filter((item) => item.id !== group.id), group]));
  }

  return (
    <>
      <Button onClick={() => void openSheet()} disabled={loading}>{loading ? "Loading…" : "New Monitor"}</Button>
      {status ? <p className="mt-2 text-[13px] text-[var(--down-text)]" aria-live="polite">{status}</p> : null}
      {open ? <MonitorSheet open monitor={null} groups={groups} onGroupCreated={addGroup} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
