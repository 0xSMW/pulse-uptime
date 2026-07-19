"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useTimezone } from "@/components/dashboard/timezone-provider";
import { apiRequest, messageForError } from "@/components/settings/settings-api";
import { useDirtyGuard } from "@/components/settings/settings-dirty";
import { CardHeading } from "@/components/settings/settings-row";
import { StatusMessage, type Message } from "@/components/settings/status-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatRelativeTime } from "@/lib/reporting/format";

export type SecuritySettingsData = {
  sessions: Array<{
    id: string;
    browser: string;
    os: string;
    ipAddress: string | null;
    createdAt: string;
    lastSeenAt: string | null;
    current: boolean;
  }>;
};

/** Client-side mirror of the server password policy in lib/auth/credentials. */
export function passwordPolicyError(password: string): string {
  if (password.length < 12) return "Use at least 12 characters";
  if (password.length > 128) return "Use no more than 128 characters";
  return "";
}

function formatSignedIn(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone }).format(date);
}

export function SecuritySettings({ data }: { data: SecuritySettingsData }) {
  const router = useRouter();
  const { resolvedTimeZone } = useTimezone();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<Message | null>(null);

  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeOthers, setRevokeOthers] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<Message | null>(null);

  const policyError = newPassword ? passwordPolicyError(newPassword) : "";
  const confirmMismatch = Boolean(newPassword) && Boolean(confirmPassword) && newPassword !== confirmPassword;
  const passwordDirty = Boolean(currentPassword || newPassword || confirmPassword);
  const submittable = Boolean(currentPassword && newPassword && confirmPassword)
    && !policyError && !confirmMismatch;

  useDirtyGuard("security-password", passwordDirty);

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submittable) return;
    setPasswordBusy(true);
    setPasswordMessage(null);
    try {
      await apiRequest("/api/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage({ text: "Password changed. Your other sessions have been signed out.", tone: "info" });
      router.refresh();
    } catch (error) {
      setPasswordMessage({ text: messageForError(error), tone: "error" });
    } finally {
      setPasswordBusy(false);
    }
  }

  async function revokeSession(id: string) {
    setSessionBusy(true);
    setSessionMessage(null);
    try {
      await apiRequest(`/api/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
      setRevokeId(null);
      setSessionMessage({ text: "Session signed out", tone: "info" });
      router.refresh();
    } catch (error) {
      setSessionMessage({ text: messageForError(error), tone: "error" });
    } finally {
      setSessionBusy(false);
    }
  }

  async function signOutOthers() {
    setSessionBusy(true);
    setSessionMessage(null);
    try {
      const payload = await apiRequest<{ data?: { revokedCount?: number } }>(
        "/api/v1/me/sessions/revoke-others",
        { method: "POST" },
        true,
      );
      const count = payload.data?.revokedCount ?? 0;
      setRevokeOthers(false);
      setSessionMessage({ text: count === 1 ? "Signed out 1 other session" : `Signed out ${count} other sessions`, tone: "info" });
      router.refresh();
    } catch (error) {
      setSessionMessage({ text: messageForError(error), tone: "error" });
    } finally {
      setSessionBusy(false);
    }
  }

  const otherSessions = data.sessions.filter((session) => !session.current);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading title="Password" />
        <CardContent className="pt-0">
          <form onSubmit={changePassword} className="max-w-[640px] space-y-3">
            <p className="text-[13px] text-[var(--fg-muted)]">
              Changing your password signs out every other session.
            </p>
            <Field label="Current password" htmlFor="security-current-password">
              <Input
                id="security-current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
                className="max-w-[320px]"
                inputSize="sm"
              />
            </Field>
            <Field
              label="New password"
              htmlFor="security-new-password"
              description="12 to 128 characters."
              error={policyError || undefined}
            >
              <Input
                id="security-new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                aria-invalid={Boolean(policyError) || undefined}
                autoComplete="new-password"
                required
                className="max-w-[320px]"
                inputSize="sm"
              />
            </Field>
            <Field
              label="Confirm new password"
              htmlFor="security-confirm-password"
              error={confirmMismatch ? "Passwords do not match" : undefined}
            >
              <Input
                id="security-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                aria-invalid={confirmMismatch || undefined}
                autoComplete="new-password"
                required
                className="max-w-[320px]"
                inputSize="sm"
              />
            </Field>
            <Button type="submit" size="sm" disabled={passwordBusy || !submittable}>
              {passwordBusy ? "Changing…" : "Change Password"}
            </Button>
            <StatusMessage message={passwordMessage} />
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeading
          title="Active Sessions"
          action={revokeOthers ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs text-[var(--down-text)]">Sign out other sessions?</span>
              <Button variant="secondary" size="sm" onClick={() => setRevokeOthers(false)} disabled={sessionBusy}>
                Cancel
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void signOutOthers()} disabled={sessionBusy}>
                {sessionBusy ? "Signing out…" : "Confirm"}
              </Button>
            </span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRevokeOthers(true)}
              disabled={otherSessions.length === 0}
            >
              Sign Out Other Sessions
            </Button>
          )}
        />
        <div className="hide-scrollbar overflow-x-auto border-t border-[var(--border)]">
          <table className="w-full min-w-[500px] border-collapse text-left text-[13px] md:min-w-[760px]">
            <thead className="text-xs text-[var(--fg-muted)]">
              <tr className="h-10 border-b border-[var(--border)]">
                <th className="px-6 font-medium">Session</th>
                <th className="px-4 font-medium max-md:hidden">IP Address</th>
                <th className="px-4 font-medium">Last Active</th>
                <th className="px-4 font-medium max-lg:hidden">Signed In</th>
                <th className="px-6 text-right font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((session) => (
                <tr key={session.id} className="h-[60px] border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]">
                  <td className="px-6">
                    <div className="font-medium">{session.browser}</div>
                    <div className="text-xs text-[var(--fg-faint)]">{session.os}</div>
                  </td>
                  <td className="px-4 font-data text-xs text-[var(--fg-muted)] max-md:hidden">
                    {session.ipAddress ?? "—"}
                  </td>
                  <td className="px-4 whitespace-nowrap font-data text-xs text-[var(--fg-muted)]">
                    {session.lastSeenAt
                      ? formatRelativeTime(new Date(session.lastSeenAt), new Date(), resolvedTimeZone)
                      : "—"}
                  </td>
                  <td className="px-4 whitespace-nowrap font-data text-xs text-[var(--fg-muted)] max-lg:hidden">
                    {formatSignedIn(session.createdAt, resolvedTimeZone)}
                  </td>
                  <td className="px-6 text-right">
                    {session.current ? (
                      <span className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                        Your current session
                      </span>
                    ) : revokeId === session.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-[var(--down-text)]">Revoke?</span>
                        <Button variant="secondary" size="sm" onClick={() => setRevokeId(null)} disabled={sessionBusy}>
                          Cancel
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => void revokeSession(session.id)} disabled={sessionBusy}>
                          {sessionBusy ? "Revoking…" : "Confirm"}
                        </Button>
                      </span>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => setRevokeId(session.id)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <StatusMessage message={sessionMessage} className="border-t border-[var(--border)] px-6 py-3" />
      </Card>
    </div>
  );
}
