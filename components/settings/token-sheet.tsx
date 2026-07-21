"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  type ApiEnvelope,
  apiRequest,
  expiryFromDays,
  messageForError,
} from "./settings-api"
import { Sheet } from "./sheet"

const scopes = [
  "monitors:read",
  "monitors:write",
  "incidents:read",
  "config:read",
  "config:write",
  "notifications:test",
  "tokens:manage",
  "status:read",
  "reports:read",
  "reports:write",
  "dependencies:read",
  "dependencies:write",
] as const

interface CreatedToken {
  token: string
}

export function TokenSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const nameRef = useRef<HTMLInputElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [days, setDays] = useState<30 | 90 | 365>(90)
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")

  useEffect(() => {
    if (!open) {
      return
    }
    requestAnimationFrame(() => nameRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selected.length > 0 && selected.length < scopes.length
    }
  }, [selected])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setStatus("Enter a token name")
      nameRef.current?.focus()
      return
    }
    if (!selected.length) {
      setStatus("Select at least one scope")
      return
    }
    setBusy(true)
    setStatus("")
    try {
      const envelope = await apiRequest<ApiEnvelope<CreatedToken>>(
        "/api/v1/tokens",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            scopes: selected,
            expiresAt: expiryFromDays(days),
          }),
        },
        { mutation: true }
      )
      setSecret(envelope.data.token)
      router.refresh()
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!secret) {
      return
    }
    try {
      await navigator.clipboard.writeText(secret)
      setStatus("Token copied")
    } catch {
      setStatus("Copy failed. Select the token manually.")
    }
  }

  return (
    <Sheet
      description={
        secret
          ? "Save this secret securely"
          : "Create a scoped agent credential"
      }
      onClose={() => !busy && onClose()}
      open={open}
      title={secret ? "Token Created" : "Create Token"}
    >
      {secret ? (
        <div>
          <div
            className="break-all rounded-[6px] border border-[var(--border-strong)] bg-[var(--verifying-bg)] p-4 font-data text-[13px] leading-5"
            tabIndex={0}
          >
            {secret}
          </div>
          <p className="mt-3 text-[13px] text-[var(--verifying-text)]">
            Copy it now. It won&apos;t be shown again.
          </p>
          {status ? (
            <p
              aria-live="polite"
              className="mt-3 text-[13px] text-[var(--fg-muted)]"
            >
              {status}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={copy} variant="secondary">
              Copy
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={create}>
          <label className="block">
            <span className="mb-1.5 block font-medium text-[13px]">Name</span>
            <input
              className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]"
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              ref={nameRef}
              value={name}
            />
          </label>
          <fieldset>
            <legend className="font-medium text-[13px]">Scopes</legend>
            <label className="mt-3 flex items-center gap-2 border-[var(--border)] border-b pb-3 font-medium text-[13px]">
              <input
                checked={selected.length === scopes.length}
                className="size-4 accent-[var(--fg)]"
                onChange={(e) =>
                  setSelected(e.target.checked ? [...scopes] : [])
                }
                ref={selectAllRef}
                type="checkbox"
              />
              Select All
            </label>
            <div className="space-y-3 pt-3">
              {scopes.map((scope) => (
                <label
                  className="flex items-center gap-2 text-[13px]"
                  key={scope}
                >
                  <input
                    checked={selected.includes(scope)}
                    className="size-4 accent-[var(--fg)]"
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...current, scope]
                          : current.filter((item) => item !== scope)
                      )
                    }
                    type="checkbox"
                  />
                  <span className="font-data">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 font-medium text-[13px]">Expires</legend>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  [30, "30 days"],
                  [90, "90 days"],
                  [365, "1 year"],
                ] as const
              ).map(([value, label]) => (
                <label
                  className={`flex h-10 cursor-pointer items-center justify-center rounded-[6px] border text-[13px] ${days === value ? "border-[var(--fg)] bg-[var(--chip-bg)] font-medium" : "border-[var(--border-strong)]"}`}
                  key={value}
                >
                  <input
                    checked={days === value}
                    className="sr-only"
                    name="expiry"
                    onChange={() => setDays(value)}
                    type="radio"
                    value={value}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {status ? (
            <p
              aria-live="polite"
              className="text-[13px] text-[var(--down-text)]"
            >
              {status}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              disabled={busy}
              onClick={onClose}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? "Creating…" : "Create Token"}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  )
}
