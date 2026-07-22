"use client"

import { ChevronDown } from "lucide-react"
import { useState } from "react"

import { AddDependencySheet } from "@/components/dependencies/add-dependency-sheet"
import { MonitorSheet } from "@/components/settings/monitor-sheet"
import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
  type SettingsGroup,
  sortSettingsGroups,
} from "@/components/settings/settings-api"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export function NewMonitorAction({
  canManageMonitors,
}: {
  canManageMonitors: boolean
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [groups, setGroups] = useState<SettingsGroup[]>([])
  const [status, setStatus] = useState("")
  const [addDependencyOpen, setAddDependencyOpen] = useState(false)

  async function openSheet() {
    setLoading(true)
    setStatus("")
    try {
      const response =
        await apiRequest<ApiEnvelope<SettingsGroup[]>>("/api/v1/groups")
      setGroups(sortSettingsGroups(response.data))
      setOpen(true)
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setLoading(false)
    }
  }

  function addGroup(group: SettingsGroup) {
    setGroups((current) =>
      sortSettingsGroups([
        ...current.filter((item) => item.id !== group.id),
        group,
      ])
    )
  }

  if (!canManageMonitors) {
    return null
  }

  return (
    <>
      {/* One unified split control: the primary button loses its right
          corners, the chevron trigger loses its left corners and carries a
          full-height hairline divider so the pair reads as a single button
          with a segment hint, not two adjacent buttons. The divider is a
          low-opacity blend of the button foreground token (--bg is the
          primary button's text color) toward transparent, so it stays quiet
          in both themes and does not pop when either segment's hover
          background changes. */}
      <div aria-label="New monitor" className="inline-flex" role="group">
        <Button
          className="rounded-r-none"
          disabled={loading}
          onClick={() => void openSheet()}
        >
          {loading ? "Loading…" : "New Monitor"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More monitor actions"
            className={cn(
              buttonVariants({ variant: "primary", size: "icon" }),
              "w-9 rounded-l-none border-l border-l-[color-mix(in_srgb,var(--bg)_15%,transparent)] px-0"
            )}
            disabled={loading}
          >
            <ChevronDown aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => void openSheet()}>
              Monitor URL
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAddDependencyOpen(true)}>
              Add Dependency
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {status ? (
        <p
          aria-live="polite"
          className="mt-2 text-[13px] text-[var(--down-text)]"
        >
          {status}
        </p>
      ) : null}
      {open ? (
        <MonitorSheet
          groups={groups}
          monitor={null}
          onClose={() => setOpen(false)}
          onGroupCreated={addGroup}
          open
        />
      ) : null}
      {addDependencyOpen ? (
        <AddDependencySheet onClose={() => setAddDependencyOpen(false)} open />
      ) : null}
    </>
  )
}
