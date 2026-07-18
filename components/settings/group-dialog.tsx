"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  apiRequest,
  generatedGroupId,
  messageForError,
  type ApiEnvelope,
  type SettingsGroup,
} from "./settings-api";

export function validateGroupName(value: string): string {
  if (!value.trim()) return "Enter a group name";
  if (value.trim().length > 50) return "Use 50 characters or fewer";
  return "";
}

export function GroupDialog({
  open,
  group = null,
  onClose,
  onSaved,
}: {
  open: boolean;
  group?: SettingsGroup | null;
  onClose: () => void;
  onSaved: (group: SettingsGroup) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState(group?.name ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextError = validateGroupName(name);
    setError(nextError);
    if (nextError) return;

    setBusy(true);
    setError("");
    try {
      const response = group
        ? await apiRequest<ApiEnvelope<SettingsGroup>>(
          `/api/v1/groups/${encodeURIComponent(group.id)}`,
          { method: "PATCH", body: JSON.stringify({ name: name.trim() }) },
          true,
        )
        : await apiRequest<ApiEnvelope<SettingsGroup>>(
          "/api/v1/groups",
          { method: "POST", body: JSON.stringify({ id: generatedGroupId(name), name: name.trim() }) },
          true,
        );
      onSaved(response.data);
    } catch (caught) {
      setError(messageForError(caught));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 z-[90] m-auto w-[min(400px,calc(100vw-32px))] rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"
    >
      <form onSubmit={submit}>
        <h3 id={titleId} className="text-base font-semibold">{group ? "Rename Group" : "Create Group"}</h3>
        <p className="mt-2 text-[13px] text-[var(--fg-muted)]">Organize related endpoint monitors</p>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[13px] font-medium">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(error)}
            className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]"
          />
          {error ? <span className="mt-1 block text-xs text-[var(--down-text)]" aria-live="polite">{error}</span> : null}
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : group ? "Save Group" : "Create Group"}</Button>
        </div>
      </form>
    </dialog>
  );
}
