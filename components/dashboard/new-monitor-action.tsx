"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { AddDependencySheet } from "@/components/dependencies/add-dependency-sheet";
import { MonitorSheet } from "@/components/settings/monitor-sheet";
import { apiRequest, messageForError, sortSettingsGroups, type ApiEnvelope, type SettingsGroup } from "@/components/settings/settings-api";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function NewMonitorAction() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [status, setStatus] = useState("");
  const [addDependencyOpen, setAddDependencyOpen] = useState(false);

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
      {/* One border-shared control: the primary button loses its right
          corners, the chevron trigger loses its left corners and picks up a
          hairline divider, so the pair reads as a single split button. */}
      <div className="inline-flex" role="group" aria-label="New monitor">
        <Button
          onClick={() => void openSheet()}
          disabled={loading}
          className="rounded-r-none"
        >
          {loading ? "Loading…" : "New Monitor"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={loading}
            aria-label="More monitor actions"
            className={cn(
              buttonVariants({ variant: "primary", size: "icon" }),
              "w-9 rounded-l-none border-l border-l-[color-mix(in_srgb,var(--bg)_25%,transparent)] px-0",
            )}
          >
            <ChevronDown className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => void openSheet()}>Monitor URL</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAddDependencyOpen(true)}>Add Dependency</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {status ? <p className="mt-2 text-[13px] text-[var(--down-text)]" aria-live="polite">{status}</p> : null}
      {open ? <MonitorSheet open monitor={null} groups={groups} onGroupCreated={addGroup} onClose={() => setOpen(false)} /> : null}
      {addDependencyOpen ? <AddDependencySheet open onClose={() => setAddDependencyOpen(false)} /> : null}
    </>
  );
}
