"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import { apiRequest, messageForError } from "@/components/settings/settings-api"
import { useDirtyGuard } from "@/components/settings/settings-dirty"
import { CardHeading } from "@/components/settings/settings-row"
import {
  type Message,
  StatusMessage,
} from "@/components/settings/status-message"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { formatCalendarDate, formatRelativeTime } from "@/lib/reporting/format"

export interface SecuritySettingsData {
  sessions: Array<{
    id: string
    browser: string
    os: string
    ipAddress: string | null
    createdAt: string
    lastSeenAt: string | null
    current: boolean
  }>
}

/** Client-side mirror of the server password policy in lib/auth/credentials. */
export function passwordPolicyError(password: string): string {
  if (password.length < 12) {
    return "Use at least 12 characters"
  }
  if (password.length > 128) {
    return "Use no more than 128 characters"
  }
  return ""
}

export function SecuritySettings({ data }: { data: SecuritySettingsData }) {
  const router = useRouter()
  const { resolvedTimeZone } = useTimezone()

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState<Message | null>(null)

  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [revokeOthers, setRevokeOthers] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionMessage, setSessionMessage] = useState<Message | null>(null)

  const policyError = newPassword ? passwordPolicyError(newPassword) : ""
  const confirmMismatch =
    Boolean(newPassword) &&
    Boolean(confirmPassword) &&
    newPassword !== confirmPassword
  const passwordDirty = Boolean(
    currentPassword || newPassword || confirmPassword
  )
  const submittable =
    Boolean(currentPassword && newPassword && confirmPassword) &&
    !policyError &&
    !confirmMismatch

  useDirtyGuard("security-password", passwordDirty)

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!submittable) {
      return
    }
    setPasswordBusy(true)
    setPasswordMessage(null)
    try {
      await apiRequest("/api/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      // Server revoked every session and expired the cookie. Sign in again.
      router.push("/login")
    } catch (error) {
      setPasswordMessage({ text: messageForError(error), tone: "error" })
      setPasswordBusy(false)
    }
  }

  async function revokeSession(id: string) {
    setSessionBusy(true)
    setSessionMessage(null)
    try {
      await apiRequest(
        `/api/v1/me/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      setRevokeId(null)
      setSessionMessage({ text: "Session signed out", tone: "info" })
      router.refresh()
    } catch (error) {
      setSessionMessage({ text: messageForError(error), tone: "error" })
    } finally {
      setSessionBusy(false)
    }
  }

  async function signOutOthers() {
    setSessionBusy(true)
    setSessionMessage(null)
    try {
      const payload = await apiRequest<{ data?: { revokedCount?: number } }>(
        "/api/v1/me/sessions/revoke-others",
        { method: "POST" },
        { mutation: true }
      )
      const count = payload.data?.revokedCount ?? 0
      setRevokeOthers(false)
      setSessionMessage({
        text:
          count === 1
            ? "Signed out 1 other session"
            : `Signed out ${count} other sessions`,
        tone: "info",
      })
      router.refresh()
    } catch (error) {
      setSessionMessage({ text: messageForError(error), tone: "error" })
    } finally {
      setSessionBusy(false)
    }
  }

  const otherSessions = data.sessions.filter((session) => !session.current)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading title="Password" />
        <CardContent className="pt-0">
          <form className="max-w-[640px] space-y-3" onSubmit={changePassword}>
            <p className="text-[13px] text-[var(--fg-muted)]">
              Changing your password signs out every session
            </p>
            <Field htmlFor="security-current-password" label="Current password">
              <Input
                autoComplete="current-password"
                className="max-w-[320px]"
                id="security-current-password"
                inputSize="sm"
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
                type="password"
                value={currentPassword}
              />
            </Field>
            <Field
              description="12 to 128 characters."
              error={policyError || undefined}
              htmlFor="security-new-password"
              label="New password"
            >
              <Input
                aria-invalid={Boolean(policyError) || undefined}
                autoComplete="new-password"
                className="max-w-[320px]"
                id="security-new-password"
                inputSize="sm"
                onChange={(event) => setNewPassword(event.target.value)}
                required
                type="password"
                value={newPassword}
              />
            </Field>
            <Field
              error={confirmMismatch ? "Passwords do not match" : undefined}
              htmlFor="security-confirm-password"
              label="Confirm new password"
            >
              <Input
                aria-invalid={confirmMismatch || undefined}
                autoComplete="new-password"
                className="max-w-[320px]"
                id="security-confirm-password"
                inputSize="sm"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                type="password"
                value={confirmPassword}
              />
            </Field>
            <Button
              disabled={passwordBusy || !submittable}
              size="sm"
              type="submit"
            >
              {passwordBusy ? "Changing…" : "Change Password"}
            </Button>
            <StatusMessage message={passwordMessage} />
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeading
          action={
            revokeOthers ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-[var(--down-text)] text-xs">
                  Sign out other sessions?
                </span>
                <Button
                  disabled={sessionBusy}
                  onClick={() => setRevokeOthers(false)}
                  size="sm"
                  variant="secondary"
                >
                  Cancel
                </Button>
                <Button
                  disabled={sessionBusy}
                  onClick={() => void signOutOthers()}
                  size="sm"
                  variant="secondary"
                >
                  {sessionBusy ? "Signing out…" : "Confirm"}
                </Button>
              </span>
            ) : (
              <Button
                disabled={otherSessions.length === 0}
                onClick={() => setRevokeOthers(true)}
                size="sm"
                variant="secondary"
              >
                Sign Out Other Sessions
              </Button>
            )
          }
          title="Active Sessions"
        />
        <div className="hide-scrollbar overflow-x-auto border-[var(--border)] border-t">
          <table className="w-full min-w-[500px] border-collapse text-left text-[13px] md:min-w-[760px]">
            <thead className="text-[var(--fg-muted)] text-xs">
              <tr className="h-10 border-[var(--border)] border-b">
                <th className="px-6 font-medium">Session</th>
                <th className="px-4 font-medium max-md:hidden">IP Address</th>
                <th className="px-4 font-medium">Last Active</th>
                <th className="px-4 font-medium max-lg:hidden">Signed In</th>
                <th className="px-6 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((session) => (
                <tr
                  className="h-[60px] border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                  key={session.id}
                >
                  <td className="px-6">
                    <div className="font-medium">{session.browser}</div>
                    <div className="text-[var(--fg-faint)] text-xs">
                      {session.os}
                    </div>
                  </td>
                  <td className="px-4 font-data text-[var(--fg-muted)] text-xs max-md:hidden">
                    {session.ipAddress ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs">
                    {session.lastSeenAt
                      ? formatRelativeTime(
                          new Date(session.lastSeenAt),
                          new Date(),
                          resolvedTimeZone
                        )
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs max-lg:hidden">
                    {formatCalendarDate(session.createdAt, resolvedTimeZone)}
                  </td>
                  <td className="px-6 text-right">
                    {session.current ? (
                      <span className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                        Your current session
                      </span>
                    ) : revokeId === session.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-[var(--down-text)] text-xs">
                          Revoke?
                        </span>
                        <Button
                          disabled={sessionBusy}
                          onClick={() => setRevokeId(null)}
                          size="sm"
                          variant="secondary"
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={sessionBusy}
                          onClick={() => void revokeSession(session.id)}
                          size="sm"
                          variant="secondary"
                        >
                          {sessionBusy ? "Revoking…" : "Confirm"}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        onClick={() => setRevokeId(session.id)}
                        size="sm"
                        variant="secondary"
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <StatusMessage
          className="border-[var(--border)] border-t px-6 py-3"
          message={sessionMessage}
        />
      </Card>
    </div>
  )
}
