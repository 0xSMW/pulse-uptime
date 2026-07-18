"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiRequest, generatedMonitorId, messageForError } from "./settings-api";
import { Sheet } from "./sheet";
import { Button } from "@/components/ui/button";

export type EditableMonitor = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
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

export type MonitorFormValues = Omit<EditableMonitor, "id"> & { recipientsText: string };
export type MonitorFormErrors = Partial<Record<keyof MonitorFormValues, string>>;

const emptyValues: MonitorFormValues = {
  name: "",
  url: "",
  group: null,
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
  return monitor ? { ...monitor, recipientsText: monitor.recipients.join("\n") } : emptyValues;
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
  if (values.group && values.group.trim().length > 50) errors.group = "Use 50 characters or fewer";
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
  return <dialog ref={ref} aria-labelledby="archive-title" onCancel={(event) => { event.preventDefault(); onCancel(); }} className="fixed inset-0 z-50 m-auto w-[min(400px,calc(100vw-32px))] rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"><h3 id="archive-title" className="text-base font-semibold">Archive Monitor</h3><p className="mt-2 text-[13px] text-[var(--fg-muted)]">Checks stop and history stays available</p><label className="mt-4 block text-[13px]"><span className="mb-2 block">Type <strong>{monitorName}</strong> to confirm</span><input autoFocus value={value} onChange={(e) => onValueChange(e.target.value)} className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]" /></label>{status ? <p className={`mt-3 text-[13px] ${status === "Monitor archived" ? "text-[var(--fg-muted)]" : "text-[var(--down-text)]"}`} aria-live="polite">{status}</p> : null}<div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button><Button variant="secondary" onClick={onConfirm} disabled={value !== monitorName || busy}>{busy ? "Archiving…" : "Archive Monitor"}</Button></div></dialog>;
}

export function MonitorSheet({ open, monitor, onClose }: { open: boolean; monitor: EditableMonitor | null; onClose: () => void }) {
  const router = useRouter();
  const firstField = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<MonitorFormValues>(() => valuesFor(monitor));
  const [errors, setErrors] = useState<MonitorFormErrors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [archiveName, setArchiveName] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
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
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setBusy("save"); setStatus("");
    const body = {
      name: values.name.trim(), url: values.url.trim(), enabled: values.enabled,
      group: values.group?.trim() || null, method: values.method,
      intervalMinutes: values.intervalMinutes, timeoutMs: values.timeoutMs,
      expectedStatus: { minimum: values.expectedStatusMin, maximum: values.expectedStatusMax },
      failureThreshold: values.failureThreshold, recoveryThreshold: values.recoveryThreshold,
      recipients: parseRecipients(values.recipientsText),
    };
    try {
      if (monitor) await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}`, { method: "PATCH", body: JSON.stringify(body) }, true);
      else await apiRequest("/api/v1/monitors", { method: "POST", body: JSON.stringify({ id: generatedMonitorId(values.name), ...body }) }, true);
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
    setBusy(action); setStatus("");
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
      setStatus("Monitor archived");
      setBusy("archived");
      propagationTimer.current = window.setTimeout(() => { router.refresh(); onClose(); }, 800);
    } catch (error) { setStatus(messageForError(error)); }
    finally { setBusy((current) => current === "archived" ? current : null); }
  }

  const inputClass = "h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]";
  return (
    <Fragment><Sheet open={open} onClose={() => !busy && onClose()} title={monitor ? "Edit Monitor" : "New Monitor"} description={monitor ? monitor.id : "Add a public endpoint"}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Name</span><input ref={firstField} value={values.name} onChange={(e) => set("name", e.target.value)} aria-invalid={Boolean(errors.name)} className={inputClass} />{errors.name ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.name}</span> : null}</label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">URL</span><input value={values.url} onChange={(e) => set("url", e.target.value)} aria-invalid={Boolean(errors.url)} className={`${inputClass} font-data`} placeholder="https://example.com/health" />{errors.url ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.url}</span> : null}</label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Group</span><input value={values.group ?? ""} onChange={(e) => set("group", e.target.value || null)} aria-invalid={Boolean(errors.group)} className={inputClass} placeholder="Ungrouped" />{errors.group ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.group}</span> : null}</label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Method</span><select value={values.method} onChange={(e) => set("method", e.target.value)} className={inputClass}><option>GET</option><option>HEAD</option></select></label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Interval</span><select value={values.intervalMinutes} onChange={(e) => set("intervalMinutes", Number(e.target.value))} className={inputClass}>{[1,5,10,15].map((value) => <option key={value} value={value}>{value} min</option>)}</select></label>
        <NumberField label="Timeout ms" value={values.timeoutMs} onChange={(v) => set("timeoutMs", v)} min={1000} max={15000} error={errors.timeoutMs} />
        <div className="grid grid-cols-2 gap-3"><NumberField label="Expected Status Min" value={values.expectedStatusMin} onChange={(v) => set("expectedStatusMin", v)} min={100} max={599} error={errors.expectedStatusMin} /><NumberField label="Expected Status Max" value={values.expectedStatusMax} onChange={(v) => set("expectedStatusMax", v)} min={100} max={599} error={errors.expectedStatusMax} /></div>
        <div className="grid grid-cols-2 gap-3"><NumberField label="Failure Threshold" value={values.failureThreshold} onChange={(v) => set("failureThreshold", v)} min={1} max={5} error={errors.failureThreshold} /><NumberField label="Recovery Threshold" value={values.recoveryThreshold} onChange={(v) => set("recoveryThreshold", v)} min={1} max={5} error={errors.recoveryThreshold} /></div>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Recipients</span><textarea rows={4} value={values.recipientsText} onChange={(e) => set("recipientsText", e.target.value)} aria-invalid={Boolean(errors.recipientsText)} className="w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px]" /><span className="mt-1 block text-xs text-[var(--fg-faint)]">Empty inherits default recipients</span>{errors.recipientsText ? <span className="mt-1 block text-xs text-[var(--down-text)]">{errors.recipientsText}</span> : null}</label>
        <label className="flex items-center justify-between gap-4 border-y border-[var(--border)] py-3 text-[13px] font-medium"><span>Enabled</span><input type="checkbox" checked={values.enabled} onChange={(e) => set("enabled", e.target.checked)} className="size-4 accent-[var(--fg)]" /></label>
        {status ? <p aria-live="polite" className={`text-[13px] ${["Updating configuration…", "Test completed", "Monitor paused", "Monitor resumed"].includes(status) ? "text-[var(--fg-muted)]" : "text-[var(--down-text)]"}`}>{status}</p> : null}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose} disabled={Boolean(busy)}>Cancel</Button><Button type="submit" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : busy === "propagation" ? "Updating…" : monitor ? "Save Monitor" : "Create Monitor"}</Button></div>
      </form>
      {monitor ? <div className="mt-8 border-t border-[var(--border)] pt-5"><h3 className="text-sm font-semibold">Monitor Actions</h3><div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={() => monitorAction(monitor.enabled ? "pause" : "resume")} disabled={Boolean(busy)}>{busy === "pause" || busy === "resume" ? "Updating…" : monitor.enabled ? "Pause" : "Resume"}</Button><Button variant="secondary" size="sm" onClick={() => monitorAction("test")} disabled={Boolean(busy)}>{busy === "test" ? "Testing…" : "Run Test"}</Button><Button variant="secondary" size="sm" onClick={() => setConfirmArchive(true)} disabled={Boolean(busy)}>Archive</Button></div></div> : null}
    </Sheet>
    {monitor && confirmArchive ? <ArchiveDialog monitorName={monitor.name} value={archiveName} busy={Boolean(busy)} status={status} onValueChange={setArchiveName} onCancel={() => { setConfirmArchive(false); setArchiveName(""); }} onConfirm={archive} /> : null}</Fragment>
  );
}
