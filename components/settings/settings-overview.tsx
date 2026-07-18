"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AppearanceControl } from "@/components/settings/appearance-control";
import { CliCard } from "@/components/settings/cli-card";
import { DatabaseHealthCard } from "@/components/settings/database-health";
import { MonitorSheet, type EditableMonitor } from "@/components/settings/monitor-sheet";
import { apiRequest, messageForError, type ApiEnvelope } from "@/components/settings/settings-api";
import { TokenSheet } from "@/components/settings/token-sheet";
import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DatabaseHealth } from "@/lib/database-health/types";
import { formatRelativeTime } from "@/lib/reporting/format";

export type SettingsOverviewData = {
  monitors: Array<EditableMonitor & { state: MonitorState }>;
  notifications: { defaultRecipients: string[]; userAgent: string; sender: string | null };
  tokens: Array<{ id: string; name: string; kind: "agent" | "cli"; detail: string | null; prefix: string; scopes: string[]; expiresAt: string; lastUsedAt: string | null }>;
  origin: string;
  databaseHealth: DatabaseHealth | null;
  databaseHealthError: boolean;
};

type DeclarativeConfig = { version: 1; settings: Record<string, unknown> & { defaultRecipients: string[] }; monitors: Array<Record<string, unknown>> };
type ConfigurationMeta = { requestId?: string; configHash?: string };
type ConfigurationPlan = { baseConfigHash: string; targetConfigHash: string; planHash: string; destructiveApprovalRequired: boolean };

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function monitorSummary(method: string, intervalMinutes: number, timeoutMs: number): string {
  const timeout = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
  return `${method} · ${intervalMinutes}m · ${timeout} timeout`;
}

function CardHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return <CardHeader className="flex-row items-center justify-between gap-4 p-6 pb-4"><CardTitle>{title}</CardTitle>{action}</CardHeader>;
}

export function SettingsOverview({ data }: { data: SettingsOverviewData }) {
  const router = useRouter();
  const [monitorSheet, setMonitorSheet] = useState<EditableMonitor | "new" | null>(null);
  const [tokenSheet, setTokenSheet] = useState(false);
  const [recipientsText, setRecipientsText] = useState(data.notifications.defaultRecipients.join("\n"));
  const [notificationBusy, setNotificationBusy] = useState<"save" | "test" | null>(null);
  const [notificationStatus, setNotificationStatus] = useState("");
  const [monitorBusy, setMonitorBusy] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState("");
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenStatus, setTokenStatus] = useState("");
  const notificationTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (notificationTimer.current !== null) window.clearTimeout(notificationTimer.current);
  }, []);

  const recipients = recipientsText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  const recipientError = recipients.length > 20 ? "Use no more than 20 addresses" : recipients.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? "Enter valid email addresses" : "";

  async function toggleMonitor(monitor: EditableMonitor) {
    const action = monitor.enabled ? "pause" : "resume";
    setMonitorBusy(monitor.id); setRowStatus("");
    try {
      await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}/${action}`, { method: "POST" }, true);
      setRowStatus(`${monitor.name} ${monitor.enabled ? "paused" : "resumed"}`); router.refresh();
    } catch (error) { setRowStatus(messageForError(error)); }
    finally { setMonitorBusy(null); }
  }

  async function saveRecipients() {
    if (recipientError) { setNotificationStatus(recipientError); return; }
    if (notificationTimer.current !== null) window.clearTimeout(notificationTimer.current);
    notificationTimer.current = null;
    setNotificationBusy("save"); setNotificationStatus("");
    try {
      const current = await apiRequest<ApiEnvelope<DeclarativeConfig> & { meta: ConfigurationMeta }>("/api/v1/config");
      const baseConfigHash = current.meta.configHash;
      if (!baseConfigHash) throw new Error("Configuration hash is unavailable. Reload before saving.");
      const targetConfig: DeclarativeConfig = { ...current.data, settings: { ...current.data.settings, defaultRecipients: recipients } };
      const planned = await apiRequest<ApiEnvelope<ConfigurationPlan>>("/api/v1/config/plan", { method: "POST", body: JSON.stringify({ baseConfigHash, targetConfig }) }, true);
      await apiRequest("/api/v1/config/apply", {
        method: "POST",
        headers: { "If-Match": `"${baseConfigHash}"` },
        body: JSON.stringify({ baseConfigHash, targetConfigHash: planned.data.targetConfigHash, planHash: planned.data.planHash, targetConfig, allowDelete: false }),
      }, true);
      setNotificationStatus("Updating configuration…");
      notificationTimer.current = window.setTimeout(() => { notificationTimer.current = null; router.refresh(); setNotificationStatus("Recipients saved"); setNotificationBusy(null); }, 10_000);
    } catch (error) { setNotificationStatus(messageForError(error)); }
    finally { setNotificationBusy((current) => current === "save" && notificationTimer.current !== null ? current : null); }
  }

  async function sendTestNotification() {
    if (recipientError) { setNotificationStatus(recipientError); return; }
    setNotificationBusy("test"); setNotificationStatus("");
    try {
      await apiRequest("/api/v1/notifications/test", { method: "POST", body: JSON.stringify(recipients[0] ? { recipient: recipients[0] } : {}) }, true);
      setNotificationStatus(recipients[0] ? `Test sent to ${recipients[0]}` : "Test notification accepted");
    } catch (error) { setNotificationStatus(messageForError(error)); }
    finally { setNotificationBusy(null); }
  }

  async function revokeToken(id: string) {
    setTokenBusy(true); setTokenStatus("");
    try {
      await apiRequest(`/api/v1/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
      setRevokeId(null); setTokenStatus("Token revoked"); router.refresh();
    } catch (error) { setTokenStatus(messageForError(error)); }
    finally { setTokenBusy(false); }
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeading title="Monitors" action={<Button variant="primary" size="sm" onClick={() => setMonitorSheet("new")}>New Monitor</Button>} />
        <div className="hide-scrollbar overflow-x-auto border-t border-[var(--border)]">
          <table className="w-full min-w-[460px] border-collapse text-left text-[13px] md:min-w-[660px]"><thead className="text-xs text-[var(--fg-muted)]"><tr className="h-10 border-b border-[var(--border)]"><th className="px-6 font-medium">Monitor</th><th className="px-4 font-medium max-md:hidden">Configuration</th><th className="px-4 font-medium max-lg:hidden">Group</th><th className="px-4 text-center font-medium">Enabled</th><th className="px-6 text-right font-medium"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{data.monitors.map((monitor) => <tr key={monitor.id} className="h-[60px] border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"><td className="px-6"><div className="flex min-w-0 items-center gap-2.5"><StatusDot state={monitor.state} /><div className="min-w-0"><Link href={`/monitors/${encodeURIComponent(monitor.id)}`} className="font-medium hover:underline">{monitor.name}</Link><div className="max-w-[360px] truncate font-data text-xs text-[var(--fg-faint)]">{monitor.url}</div></div></div></td><td className="px-4 font-data text-xs text-[var(--fg-muted)] max-md:hidden">{monitorSummary(monitor.method, monitor.intervalMinutes, monitor.timeoutMs)}</td><td className="px-4 text-xs text-[var(--fg-muted)] max-lg:hidden">{monitor.group ?? "Ungrouped"}</td><td className="px-4 text-center"><button type="button" role="switch" aria-checked={monitor.enabled} aria-label={`${monitor.enabled ? "Pause" : "Resume"} ${monitor.name}`} disabled={monitorBusy === monitor.id} onClick={() => toggleMonitor(monitor)} className={`relative h-5 w-9 rounded-full border border-[var(--border-strong)] ${monitor.enabled ? "bg-[var(--fg)]" : "bg-[var(--chip-bg)]"}`}><span aria-hidden="true" className={`absolute top-[3px] size-3 rounded-full ${monitor.enabled ? "left-[19px] bg-[var(--bg)]" : "left-[3px] bg-[var(--fg-muted)]"}`} /></button></td><td className="px-6 text-right"><Button variant="tertiary" size="sm" onClick={() => setMonitorSheet(monitor)}>Edit</Button></td></tr>)}</tbody></table>
          {data.monitors.length === 0 ? <div className="px-6 py-12 text-center"><p className="font-medium">No monitors configured</p><p className="mt-1 text-[13px] text-[var(--fg-muted)]">Create your first endpoint monitor</p></div> : null}
        </div>
        {rowStatus ? <p className="border-t border-[var(--border)] px-6 py-3 text-[13px] text-[var(--fg-muted)]" aria-live="polite">{rowStatus}</p> : null}
      </Card>

      <Card><CardHeading title="Notifications" /><CardContent className="pt-0"><p className="mb-4 max-w-[640px] text-[13px] leading-[18px] text-[var(--fg-muted)]">Defaults apply when a monitor has no recipients. Use one address per line, up to 20.</p><div className="max-w-[640px] space-y-4"><label className="block"><span className="mb-2 block text-[13px] font-medium">Default Recipients</span><textarea value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)} rows={Math.max(3, Math.min(recipients.length || 3, 6))} aria-invalid={Boolean(recipientError)} placeholder="ops@example.com" className="w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px] leading-5" />{recipientError ? <span className="mt-1 block text-xs text-[var(--down-text)]">{recipientError}</span> : null}</label><label className="block"><span className="mb-2 block text-[13px] font-medium">User Agent</span><input value={data.notifications.userAgent} readOnly className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--chip-bg)] px-3 font-data text-[13px] text-[var(--fg-muted)]" /></label><div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4"><span className="font-data text-[13px] text-[var(--fg-muted)]">{data.notifications.sender ? `${data.notifications.sender} via Resend` : "Email sender is not configured"}</span><div className="flex gap-2"><Button variant="secondary" onClick={sendTestNotification} disabled={Boolean(notificationBusy)}>{notificationBusy === "test" ? "Sending…" : "Send Test Email"}</Button><Button onClick={saveRecipients} disabled={Boolean(notificationBusy) || Boolean(recipientError)}>{notificationBusy === "save" ? "Saving…" : "Save Recipients"}</Button></div></div>{notificationStatus ? <p aria-live="polite" className={`text-[13px] ${notificationStatus.includes("changed elsewhere") || notificationStatus.includes("unavailable") ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}>{notificationStatus}</p> : null}</div></CardContent></Card>

      <Card className="overflow-hidden"><CardHeading title="API Tokens" action={<Button variant="primary" size="sm" onClick={() => setTokenSheet(true)}>Create Token</Button>} /><div className="hide-scrollbar overflow-x-auto border-t border-[var(--border)]"><table className="w-full min-w-[500px] border-collapse text-left text-[13px] md:min-w-[760px]"><thead className="text-xs text-[var(--fg-muted)]"><tr className="h-10 border-b border-[var(--border)]"><th className="px-6 font-medium">Name</th><th className="px-4 font-medium max-lg:hidden">Token</th><th className="px-4 font-medium max-md:hidden">Scopes</th><th className="px-4 font-medium">Expires</th><th className="px-4 font-medium max-xl:hidden">Last Used</th><th className="px-6 text-right font-medium"><span className="sr-only">Actions</span></th></tr></thead><tbody>{data.tokens.map((token) => <tr key={`${token.kind}-${token.id}`} className="h-[60px] border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"><td className="px-6"><div className="font-medium">{token.name}</div><div className="text-xs text-[var(--fg-faint)]">{token.kind === "agent" ? "Agent token" : `CLI session${token.detail ? ` · ${token.detail}` : ""}`}</div></td><td className="px-4 font-data text-xs text-[var(--fg-muted)] max-lg:hidden">{token.prefix}····</td><td className="px-4 max-md:hidden"><div className="flex max-w-[360px] flex-wrap gap-1">{token.scopes.map((scope) => <span key={scope} className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px]">{scope}</span>)}</div></td><td className="px-4 whitespace-nowrap font-data text-xs text-[var(--fg-muted)]">{formatExpiry(token.expiresAt)}</td><td className="px-4 whitespace-nowrap font-data text-xs text-[var(--fg-muted)] max-xl:hidden">{token.lastUsedAt ? formatRelativeTime(new Date(token.lastUsedAt)) : "Never"}</td><td className="px-6 text-right">{token.kind === "agent" ? <>{revokeId === token.id ? <span className="inline-flex items-center gap-2"><span className="text-xs text-[var(--down-text)]">Revoke?</span><Button variant="secondary" size="sm" onClick={() => setRevokeId(null)} disabled={tokenBusy}>Cancel</Button><Button variant="secondary" size="sm" onClick={() => revokeToken(token.id)} disabled={tokenBusy}>{tokenBusy ? "Revoking…" : "Confirm"}</Button></span> : <Button variant="secondary" size="sm" onClick={() => setRevokeId(token.id)}>Revoke</Button>}</> : <span className="text-xs text-[var(--fg-faint)]">Linked session</span>}</td></tr>)}</tbody></table>{data.tokens.length === 0 ? <div className="px-6 py-12 text-center"><p className="font-medium">No API tokens</p><p className="mt-1 text-[13px] text-[var(--fg-muted)]">Create a token for agents and CI</p></div> : null}</div>{tokenStatus ? <p className="border-t border-[var(--border)] px-6 py-3 text-[13px] text-[var(--fg-muted)]" aria-live="polite">{tokenStatus}</p> : null}</Card>

      <DatabaseHealthCard initialData={data.databaseHealth} initialError={data.databaseHealthError} />
      <Card><CardHeading title="CLI" /><CardContent className="pt-0"><CliCard origin={data.origin} /></CardContent></Card>
      <Card><CardHeading title="Appearance" /><CardContent className="pt-0"><p className="mb-4 text-[13px] leading-[18px] text-[var(--fg-muted)]">Choose how the dashboard looks on this device.</p><AppearanceControl /></CardContent></Card>

      {monitorSheet !== null ? <MonitorSheet key={monitorSheet === "new" ? "new" : monitorSheet.id} open monitor={monitorSheet === "new" ? null : monitorSheet} onClose={() => setMonitorSheet(null)} /> : null}
      {tokenSheet ? <TokenSheet open onClose={() => setTokenSheet(false)} /> : null}
    </div>
  );
}
