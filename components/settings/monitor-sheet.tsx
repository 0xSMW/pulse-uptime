"use client";

import { Activity, Archive, ChevronDown, Pause, Play } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiRequest, generatedMonitorId, messageForError } from "./settings-api";
import { GroupDialog } from "./group-dialog";
import { sortSettingsGroups, type SettingsGroup } from "./settings-api";
import { Sheet, SheetIconButton } from "./sheet";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type EditableMonitor = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  groupId: string | null;
  group: string | null;
  method: string;
  intervalMinutes: number;
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
  failureThreshold: number;
  recoveryThreshold: number;
  recipients: string[];
};

export type MonitorFormValues = Omit<EditableMonitor, "id" | "group"> & { recipientsText: string };
export type MonitorFormErrors = Partial<Record<keyof MonitorFormValues, string>>;

const advancedMonitorFields = ["timeoutMs", "expectedStatusMin", "expectedStatusMax", "failureThreshold", "recoveryThreshold", "recipientsText"] as const;

export function hasAdvancedMonitorFormErrors(errors: MonitorFormErrors): boolean {
  return advancedMonitorFields.some((field) => Boolean(errors[field]));
}

export function monitorSheetActionLabels(enabled: boolean) {
  return ["Run Test", enabled ? "Pause" : "Resume", "Archive"] as const;
}

const emptyValues: MonitorFormValues = {
  name: "",
  url: "",
  groupId: null,
  method: "GET",
  intervalMinutes: 1,
  timeoutMs: 8000,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: [],
  recipientsText: "",
  enabled: true,
};

function valuesFor(monitor: EditableMonitor | null): MonitorFormValues {
  if (!monitor) return emptyValues;
  return {
    name: monitor.name,
    url: monitor.url,
    enabled: monitor.enabled,
    groupId: monitor.groupId,
    method: monitor.method,
    intervalMinutes: monitor.intervalMinutes,
    timeoutMs: monitor.timeoutMs,
    expectedStatusMin: monitor.expectedStatusMin,
    expectedStatusMax: monitor.expectedStatusMax,
    failureThreshold: monitor.failureThreshold,
    recoveryThreshold: monitor.recoveryThreshold,
    recipients: monitor.recipients,
    recipientsText: monitor.recipients.join("\n"),
  };
}

export function parseRecipients(value: string): string[] {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

export function isPublicMonitorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || !url.hostname) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split(".").map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
      const [a, b] = parts;
      return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
    }
    if (host.includes(":")) return !(host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(host) || host.startsWith("2001:db8:"));
    return true;
  } catch { return false; }
}

export function validateMonitorForm(values: MonitorFormValues): MonitorFormErrors {
  const errors: MonitorFormErrors = {};
  if (!values.name.trim()) errors.name = "Enter a monitor name";
  else if (values.name.trim().length > 80) errors.name = "Use 80 characters or fewer";
  if (!isPublicMonitorUrl(values.url)) errors.url = "Enter a public HTTP or HTTPS URL";
  if (!Number.isInteger(values.timeoutMs) || values.timeoutMs < 1000 || values.timeoutMs > 15000) errors.timeoutMs = "Enter 1000–15000";
  if (!Number.isInteger(values.expectedStatusMin) || values.expectedStatusMin < 100 || values.expectedStatusMin > 599) errors.expectedStatusMin = "Enter 100–599";
  if (!Number.isInteger(values.expectedStatusMax) || values.expectedStatusMax < values.expectedStatusMin || values.expectedStatusMax > 599) errors.expectedStatusMax = "Enter a value from minimum to 599";
  if (!Number.isInteger(values.failureThreshold) || values.failureThreshold < 1 || values.failureThreshold > 5) errors.failureThreshold = "Enter 1–5";
  if (!Number.isInteger(values.recoveryThreshold) || values.recoveryThreshold < 1 || values.recoveryThreshold > 5) errors.recoveryThreshold = "Enter 1–5";
  const recipients = parseRecipients(values.recipientsText);
  if (recipients.length > 20) errors.recipientsText = "Use no more than 20 addresses";
  else if (recipients.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.recipientsText = "Enter valid email addresses";
  return errors;
}

function NumberField({ label, value, error, onChange, min, max }: { label: string; value: number; error?: string; onChange: (value: number) => void; min: number; max: number }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-invalid={Boolean(error)} className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 font-data text-[13px]" />
      {error ? <span className="mt-1 block text-xs text-[var(--down-text)]">{error}</span> : null}
    </label>
  );
}

function ArchiveDialog({ monitorName, value, busy, status, onValueChange, onCancel, onConfirm }: { monitorName: string; value: string; busy: boolean; status: string; onValueChange: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return <dialog ref={ref} aria-labelledby="archive-title" onCancel={(event) => { event.preventDefault(); onCancel(); }} className="fixed inset-0 z-50 m-auto w-[min(400px,calc(100vw-32px))] rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"><h3 id="archive-title" className="text-base font-semibold">Archive Monitor</h3><p className="mt-2 text-[13px] text-[var(--fg-muted)]">Checks stop and history stays available</p><label className="mt-4 block text-[13px]"><span className="mb-2 block">Type <strong>{monitorName}</strong> to confirm</span><input autoFocus value={value} onChange={(e) => onValueChange(e.target.value)} className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]" /></label>{status ? <p className={`mt-3 text-[13px] ${status === "Monitor archived" ? "text-[var(--fg-muted)]" : "text-[var(--down-text)]"}`} aria-live="polite">{status}</p> : null}<div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button><Button variant="error" onClick={onConfirm} disabled={value !== monitorName || busy}>{busy ? "Archiving…" : "Archive Monitor"}</Button></div></dialog>;
}

export function MonitorSheet({ open, monitor, groups, onGroupCreated, onMonitorGroupChanged, onClose }: { open: boolean; monitor: EditableMonitor | null; groups: readonly SettingsGroup[]; onGroupCreated: (group: SettingsGroup) => void; onMonitorGroupChanged?: (previousGroupId: string | null, nextGroupId: string | null) => void; onClose: () => void }) {
  const router = useRouter();
  const firstField = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<MonitorFormValues>(() => valuesFor(monitor));
  const [errors, setErrors] = useState<MonitorFormErrors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [archiveName, setArchiveName] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [createGroup, setCreateGroup] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const propagationTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => firstField.current?.focus());
  }, [open]);

  useEffect(() => () => {
    if (propagationTimer.current !== null) window.clearTimeout(propagationTimer.current);
  }, []);

  const set = <K extends keyof MonitorFormValues>(key: K, value: MonitorFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateMonitorForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      if (hasAdvancedMonitorFormErrors(nextErrors)) setAdvancedOpen(true);
      requestAnimationFrame(() => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()));
      return;
    }
    setBusy("save"); setStatus("");
    const body = {
      name: values.name.trim(), url: values.url.trim(), enabled: values.enabled,
      groupId: values.groupId, method: values.method,
      intervalMinutes: values.intervalMinutes, timeoutMs: values.timeoutMs,
      expectedStatus: { minimum: values.expectedStatusMin, maximum: values.expectedStatusMax },
      failureThreshold: values.failureThreshold, recoveryThreshold: values.recoveryThreshold,
      recipients: parseRecipients(values.recipientsText),
    };
    try {
      if (monitor) await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}`, { method: "PATCH", body: JSON.stringify(body) }, true);
      else await apiRequest("/api/v1/monitors", { method: "POST", body: JSON.stringify({ id: generatedMonitorId(values.name), ...body }) }, true);
      onMonitorGroupChanged?.(monitor?.groupId ?? null, values.groupId);
      setStatus("Updating configuration…");
      setBusy("propagation");
      propagationTimer.current = window.setTimeout(() => {
        router.refresh();
        onClose();
      }, 10_000);
    } catch (error) { setStatus(messageForError(error)); }
    finally { setBusy((current) => current === "propagation" ? current : null); }
  }

  async function monitorAction(action: "pause" | "resume" | "test") {
    if (!monitor) return;
    setBusy(action);
    setStatus(action === "test" ? "Testing…" : action === "pause" ? "Pausing…" : "Resuming…");
    try {
      await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}/${action}`, { method: "POST" }, true);
      setStatus(action === "test" ? "Test completed" : action === "pause" ? "Monitor paused" : "Monitor resumed");
      router.refresh();
    } catch (error) { setStatus(messageForError(error)); }
    finally { setBusy(null); }
  }

  async function archive() {
    if (!monitor || archiveName !== monitor.name) return;
    setBusy("archive"); setStatus("");
    try {
      await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}`, { method: "DELETE" }, true);
      onMonitorGroupChanged?.(monitor.groupId, null);
      setStatus("Monitor archived");
      setBusy("archived");
      propagationTimer.current = window.setTimeout(() => { router.refresh(); onClose(); }, 800);
    } catch (error) { setStatus(messageForError(error)); }
    finally { setBusy((current) => current === "archived" ? current : null); }
  }

  const inputClass = "h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]";
  const [testLabel, toggleLabel, archiveLabel] = monitorSheetActionLabels(monitor?.enabled ?? true);
  const actionBusyDescription = "Another monitor action is in progress";
  const sortedGroups = sortSettingsGroups(groups);
  function createdGroup(group: SettingsGroup) {
    onGroupCreated(group);
    set("groupId", group.id);
    setCreateGroup(false);
  }
  return (
    <Fragment><Sheet
      open={open}
      onClose={() => !busy && onClose()}
      closeDisabled={Boolean(busy)}
      title={monitor ? "Edit Monitor" : "New Monitor"}
      description={monitor ? monitor.id : "Add a public endpoint"}
      headerActions={monitor ? <>
        <SheetIconButton label={testLabel} disabled={Boolean(busy)} disabledDescription={actionBusyDescription} onClick={() => void monitorAction("test")}>
          <Activity className="size-4" aria-hidden />
        </SheetIconButton>
        <SheetIconButton label={toggleLabel} disabled={Boolean(busy)} disabledDescription={actionBusyDescription} onClick={() => void monitorAction(monitor.enabled ? "pause" : "resume")}>
          {monitor.enabled ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </SheetIconButton>
        <SheetIconButton label={archiveLabel} destructive disabled={Boolean(busy)} disabledDescription={actionBusyDescription} onClick={() => setConfirmArchive(true)}>
          <Archive className="size-4" aria-hidden />
        </SheetIconButton>
      </> : undefined}
    >
      <form ref={formRef} onSubmit={submit} className="space-y-4">
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Name</span><input ref={firstField} value={values.name} onChange={(e) => set("name", e.target.value)} aria-invalid={Boolean(errors.name)} className={inputClass} />{errors.name ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.name}</span> : null}</label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">URL</span><input value={values.url} onChange={(e) => set("url", e.target.value)} aria-invalid={Boolean(errors.url)} className={`${inputClass} font-data`} placeholder="https://example.com/health" />{errors.url ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.url}</span> : null}</label>
        <div>
          <label id="monitor-group-label" className="mb-1.5 block text-[13px] font-medium">Group</label>
          {sortedGroups.length === 0 ? (
            <Button className="w-full" variant="secondary" onClick={() => setCreateGroup(true)}>Create Group</Button>
          ) : (
            <Select value={values.groupId ?? "__ungrouped__"} onValueChange={(value) => {
              if (value === "__create__") setCreateGroup(true);
              else set("groupId", value === "__ungrouped__" ? null : value);
            }}>
              <SelectTrigger aria-labelledby="monitor-group-label"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__ungrouped__">Ungrouped</SelectItem>
                {sortedGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
                <SelectItem value="__create__">Create group</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div><label id="monitor-method-label" className="mb-1.5 block text-[13px] font-medium">Method</label><Select value={values.method} onValueChange={(value) => set("method", value)}><SelectTrigger aria-labelledby="monitor-method-label"><SelectValue /></SelectTrigger><SelectContent>{["GET", "HEAD"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
        <div><label id="monitor-interval-label" className="mb-1.5 block text-[13px] font-medium">Interval</label><Select value={String(values.intervalMinutes)} onValueChange={(value) => set("intervalMinutes", Number(value))}><SelectTrigger aria-labelledby="monitor-interval-label"><SelectValue /></SelectTrigger><SelectContent>{[1,5,10,15].map((value) => <SelectItem key={value} value={String(value)}>{value} min</SelectItem>)}</SelectContent></Select></div>
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="border-y border-[var(--border)]">
          <CollapsibleTrigger className="group flex w-full items-center justify-between py-3 text-left text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            Advanced
            <ChevronDown className="size-4 text-[var(--fg-muted)] transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pb-4 transition-opacity duration-150">
            <NumberField label="Timeout ms" value={values.timeoutMs} onChange={(v) => set("timeoutMs", v)} min={1000} max={15000} error={errors.timeoutMs} />
            <div className="grid grid-cols-2 gap-3"><NumberField label="Expected Status Min" value={values.expectedStatusMin} onChange={(v) => set("expectedStatusMin", v)} min={100} max={599} error={errors.expectedStatusMin} /><NumberField label="Expected Status Max" value={values.expectedStatusMax} onChange={(v) => set("expectedStatusMax", v)} min={100} max={599} error={errors.expectedStatusMax} /></div>
            <div className="grid grid-cols-2 gap-3"><NumberField label="Failure Threshold" value={values.failureThreshold} onChange={(v) => set("failureThreshold", v)} min={1} max={5} error={errors.failureThreshold} /><NumberField label="Recovery Threshold" value={values.recoveryThreshold} onChange={(v) => set("recoveryThreshold", v)} min={1} max={5} error={errors.recoveryThreshold} /></div>
            <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Recipients</span><textarea rows={4} value={values.recipientsText} onChange={(e) => set("recipientsText", e.target.value)} aria-invalid={Boolean(errors.recipientsText)} className="w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px]" /><span className="mt-1 block text-xs text-[var(--fg-faint)]">Empty inherits default recipients</span>{errors.recipientsText ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.recipientsText}</span> : null}</label>
          </CollapsibleContent>
        </Collapsible>
        <label className="flex items-center justify-between gap-4 border-y border-[var(--border)] py-3 text-[13px] font-medium"><span>Enabled</span><input type="checkbox" checked={values.enabled} onChange={(e) => set("enabled", e.target.checked)} className="size-4 accent-[var(--fg)]" /></label>
        {status ? <p aria-live="polite" className={`text-[13px] ${["Updating configuration…", "Testing…", "Pausing…", "Resuming…", "Test completed", "Monitor paused", "Monitor resumed"].includes(status) ? "text-[var(--fg-muted)]" : "text-[var(--down-text)]"}`}>{status}</p> : null}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose} disabled={Boolean(busy)}>Cancel</Button><Button type="submit" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : busy === "propagation" ? "Updating…" : monitor ? "Save Monitor" : "Create Monitor"}</Button></div>
      </form>
    </Sheet>
    {monitor && confirmArchive ? <ArchiveDialog monitorName={monitor.name} value={archiveName} busy={Boolean(busy)} status={status} onValueChange={setArchiveName} onCancel={() => { setConfirmArchive(false); setArchiveName(""); }} onConfirm={archive} /> : null}
    {createGroup ? <GroupDialog open onClose={() => setCreateGroup(false)} onSaved={createdGroup} /> : null}</Fragment>
  );
}
