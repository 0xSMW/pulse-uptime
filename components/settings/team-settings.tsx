"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { useTimezone } from "@/components/dashboard/timezone-provider"
import { apiRequest, messageForError } from "@/components/settings/settings-api"
import { CardHeading } from "@/components/settings/settings-row"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatCalendarDate, formatRelativeTime } from "@/lib/reporting/format"

export interface TeamSettingsData {
  currentUserId: string
  origin: string
  users: Array<{
    id: string
    email: string
    name: string | null
    role: "admin" | "viewer"
    createdAt: string
    lastSeenAt: string | null
  }>
  invites: Array<{
    id: string
    role: "admin" | "viewer"
    createdAt: string
    expiresAt: string
  }>
}

interface CreatedInviteEnvelope {
  data: { joinPath: string; role: string; expiresAt: string }
}

interface ChangedUserEnvelope {
  data: {
    email: string
    role: string
    revokedCliSessions: number
    revokedApiTokens: number
  }
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px]">
      {role}
    </span>
  )
}

export function TeamSettings({ data }: { data: TeamSettingsData }) {
  const router = useRouter()
  const { resolvedTimeZone } = useTimezone()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer">("viewer")
  const [createdLink, setCreatedLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{
    id: string
    email: string
  } | null>(null)

  function linkBase(): string {
    return data.origin || window.location.origin
  }

  async function createInvite() {
    setBusy(true)
    setStatus("")
    setCreatedLink(null)
    setCopied(false)
    try {
      const envelope = await apiRequest<CreatedInviteEnvelope>(
        "/api/v1/users/invites",
        { method: "POST", body: JSON.stringify({ role: inviteRole }) },
        { mutation: true }
      )
      setCreatedLink(`${linkBase()}${envelope.data.joinPath}`)
      router.refresh()
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setStatus("Copy failed. Select the link text and copy it manually")
    }
  }

  async function revokeInvite(id: string) {
    setBusy(true)
    setStatus("")
    try {
      await apiRequest(
        `/api/v1/users/invites/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      setStatus("Invite revoked")
      router.refresh()
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(userId: string, role: string) {
    setBusy(true)
    setStatus("")
    try {
      const envelope = await apiRequest<ChangedUserEnvelope>(
        `/api/v1/users/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: JSON.stringify({ role }) },
        { mutation: true }
      )
      const revoked =
        envelope.data.revokedCliSessions + envelope.data.revokedApiTokens
      setStatus(
        revoked > 0
          ? `${envelope.data.email} is now ${envelope.data.role}. ${revoked} CLI ${revoked === 1 ? "session or API token was" : "sessions and API tokens were"} revoked`
          : `${envelope.data.email} is now ${envelope.data.role}`
      )
      router.refresh()
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  async function confirmRemove() {
    if (!removeTarget) {
      return
    }
    setBusy(true)
    setStatus("")
    try {
      await apiRequest(
        `/api/v1/users/${encodeURIComponent(removeTarget.id)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      setStatus(`${removeTarget.email} was removed`)
      setRemoveTarget(null)
      router.refresh()
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeading title="Members" />
        <div className="hide-scrollbar overflow-x-auto border-[var(--border)] border-t">
          <table className="w-full min-w-[500px] border-collapse text-left text-[13px] md:min-w-[680px]">
            <thead className="text-[var(--fg-muted)] text-xs">
              <tr className="h-10 border-[var(--border)] border-b">
                <th className="px-6 font-medium">Member</th>
                <th className="px-4 font-medium">Role</th>
                <th className="px-4 font-medium max-md:hidden">Last Active</th>
                <th className="px-6 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => {
                const self = user.id === data.currentUserId
                return (
                  <tr
                    className="h-[60px] border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                    key={user.id}
                  >
                    <td className="px-6">
                      <div
                        className="max-w-[240px] truncate font-medium"
                        title={user.email}
                      >
                        {user.name || user.email}
                        {self ? (
                          <span className="ml-2 text-[var(--fg-faint)] text-xs">
                            you
                          </span>
                        ) : null}
                      </div>
                      {user.name ? (
                        <div className="max-w-[240px] truncate text-[var(--fg-faint)] text-xs">
                          {user.email}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4">
                      {self ? (
                        <RoleBadge role={user.role} />
                      ) : (
                        <Select
                          disabled={busy}
                          onValueChange={(role) => changeRole(user.id, role)}
                          value={user.role}
                        >
                          <SelectTrigger
                            aria-label={`Role for ${user.email}`}
                            className="h-8 w-[110px] text-[13px]"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="viewer">viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs max-md:hidden">
                      {user.lastSeenAt
                        ? formatRelativeTime(
                            new Date(user.lastSeenAt),
                            new Date(),
                            resolvedTimeZone
                          )
                        : "Never"}
                    </td>
                    <td className="px-6 text-right">
                      {self ? (
                        <span className="text-[var(--fg-faint)] text-xs">
                          Signed in
                        </span>
                      ) : (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            setRemoveTarget({ id: user.id, email: user.email })
                          }
                          size="sm"
                          variant="secondary"
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeading title="Invite" />
        <CardContent className="border-[var(--border)] border-t">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              disabled={busy}
              onValueChange={(role) =>
                setInviteRole(role === "admin" ? "admin" : "viewer")
              }
              value={inviteRole}
            >
              <SelectTrigger
                aria-label="Role for the new invite"
                className="h-9 w-[130px] text-[13px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={busy}
              onClick={createInvite}
              size="sm"
              variant="primary"
            >
              Create Link
            </Button>
            <p className="text-[13px] text-[var(--fg-muted)]">
              Links are single use and expire in 7 days
            </p>
          </div>
          {createdLink ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--chip-bg)] px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-data text-xs">
                {createdLink}
              </code>
              <Button
                onClick={() => copyLink(createdLink)}
                size="sm"
                variant="secondary"
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <p className="w-full text-[var(--fg-faint)] text-xs">
                Send this link yourself. It is shown only once
              </p>
            </div>
          ) : null}
        </CardContent>
        {data.invites.length > 0 ? (
          <div className="hide-scrollbar overflow-x-auto border-[var(--border)] border-t">
            <table className="w-full min-w-[420px] border-collapse text-left text-[13px]">
              <thead className="text-[var(--fg-muted)] text-xs">
                <tr className="h-10 border-[var(--border)] border-b">
                  <th className="px-6 font-medium">Pending Invite</th>
                  <th className="px-4 font-medium">Role</th>
                  <th className="px-4 font-medium">Expires</th>
                  <th className="px-6 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.invites.map((invite) => (
                  <tr
                    className="h-12 border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                    key={invite.id}
                  >
                    <td className="px-6 font-data text-[var(--fg-muted)] text-xs">
                      Created{" "}
                      {formatCalendarDate(invite.createdAt, resolvedTimeZone)}
                    </td>
                    <td className="px-4">
                      <RoleBadge role={invite.role} />
                    </td>
                    <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs">
                      {formatCalendarDate(invite.expiresAt, resolvedTimeZone)}
                    </td>
                    <td className="px-6 text-right">
                      <Button
                        disabled={busy}
                        onClick={() => revokeInvite(invite.id)}
                        size="sm"
                        variant="secondary"
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      {status ? (
        <p aria-live="polite" className="text-[13px] text-[var(--fg-muted)]">
          {status}
        </p>
      ) : null}

      <ConfirmDialog
        confirmLabel="Remove"
        description={
          removeTarget
            ? `${removeTarget.email} loses access immediately. Their sessions, CLI logins, and API tokens are revoked.`
            : undefined
        }
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
        open={Boolean(removeTarget)}
        title="Remove this member?"
      />
    </div>
  )
}
