"use client"

import { useId } from "react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { type SettingsGroup, sortSettingsGroups } from "./settings-api"

// Sentinel select values that can never collide with a real group id.
const UNGROUPED_VALUE = "__ungrouped__"
const CREATE_VALUE = "__create__"

// Group control shared by every monitor create and edit form. It always
// produces a group id, never a free text group name. An empty group list
// renders a create action instead of an empty select. The create option
// defers to the host's group creation dialog, so the host stays the owner
// of its group list and of selecting the newly created group.
export function MonitorGroupField({
  groups,
  labelClassName,
  onChange,
  onCreateGroup,
  value,
}: {
  groups: readonly SettingsGroup[]
  labelClassName: string
  onChange: (groupId: string | null) => void
  onCreateGroup: () => void
  value: string | null
}) {
  const labelId = useId()
  return (
    <div>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: linked to the Select via aria-labelledby on its trigger */}
      <label
        className={`mb-1.5 block font-medium ${labelClassName}`}
        id={labelId}
      >
        Group
      </label>
      {groups.length === 0 ? (
        <Button
          className="w-full"
          onClick={onCreateGroup}
          type="button"
          variant="secondary"
        >
          Create Group
        </Button>
      ) : (
        <Select
          onValueChange={(next) => {
            if (next === CREATE_VALUE) {
              onCreateGroup()
            } else {
              onChange(next === UNGROUPED_VALUE ? null : next)
            }
          }}
          value={value ?? UNGROUPED_VALUE}
        >
          <SelectTrigger aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNGROUPED_VALUE}>Ungrouped</SelectItem>
            {sortSettingsGroups(groups).map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.name}
              </SelectItem>
            ))}
            <SelectItem value={CREATE_VALUE}>Create group</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
