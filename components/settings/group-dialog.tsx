"use client"

import { useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"

import {
  type ApiEnvelope,
  apiRequest,
  generatedGroupId,
  messageForError,
  type SettingsGroup,
} from "./settings-api"

export function validateGroupName(value: string): string {
  if (!value.trim()) {
    return "Enter a group name"
  }
  if (value.trim().length > 50) {
    return "Use 50 characters or fewer"
  }
  return ""
}

export function GroupDialog({
  open,
  group = null,
  onClose,
  onSaved,
}: {
  open: boolean
  group?: SettingsGroup | null
  onClose: () => void
  onSaved: (group: SettingsGroup) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [name, setName] = useState(group?.name ?? "")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && !ref.current?.open) {
      ref.current?.showModal()
    }
  }, [open])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const nextError = validateGroupName(name)
    setError(nextError)
    if (nextError) {
      return
    }

    setBusy(true)
    setError("")
    try {
      const response = group
        ? await apiRequest<ApiEnvelope<SettingsGroup>>(
            `/api/v1/groups/${encodeURIComponent(group.id)}`,
            { method: "PATCH", body: JSON.stringify({ name: name.trim() }) },
            true
          )
        : await apiRequest<ApiEnvelope<SettingsGroup>>(
            "/api/v1/groups",
            {
              method: "POST",
              body: JSON.stringify({
                id: generatedGroupId(name),
                name: name.trim(),
              }),
            },
            true
          )
      onSaved(response.data)
    } catch (caught) {
      setError(messageForError(caught))
      setBusy(false)
    }
  }

  return (
    <dialog
      aria-labelledby={titleId}
      className="fixed inset-0 z-[90] m-auto w-[min(400px,calc(100vw-32px))] rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) {
          onClose()
        }
      }}
      ref={ref}
    >
      <form onSubmit={submit}>
        <h3 className="font-semibold text-base" id={titleId}>
          {group ? "Rename Group" : "Create Group"}
        </h3>
        <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
          Organize related endpoint monitors
        </p>
        <label className="mt-4 block">
          <span className="mb-1.5 block font-medium text-[13px]">Name</span>
          <input
            aria-invalid={Boolean(error)}
            autoFocus
            className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          {error ? (
            <span
              aria-live="polite"
              className="mt-1 block text-[var(--down-text)] text-xs"
            >
              {error}
            </span>
          ) : null}
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={busy} onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : group ? "Save Group" : "Create Group"}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
