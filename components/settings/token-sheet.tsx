"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { apiRequest, expiryFromDays, messageForError, type ApiEnvelope } from "./settings-api";
import { Sheet } from "./sheet";

const scopes = [
  "monitors:read", "monitors:write", "incidents:read", "config:read",
  "config:write", "notifications:test", "tokens:manage", "status:read",
  "reports:read", "reports:write",
] as const;

type CreatedToken = { token: string };

export function TokenSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState<30 | 90 | 365>(90);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.length > 0 && selected.length < scopes.length;
  }, [selected]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setStatus("Enter a token name"); nameRef.current?.focus(); return; }
    if (!selected.length) { setStatus("Select at least one scope"); return; }
    setBusy(true); setStatus("");
    try {
      const envelope = await apiRequest<ApiEnvelope<CreatedToken>>("/api/v1/tokens", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), scopes: selected, expiresAt: expiryFromDays(days) }),
      }, true);
      setSecret(envelope.data.token);
      router.refresh();
    } catch (error) { setStatus(messageForError(error)); }
    finally { setBusy(false); }
  }

  async function copy() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); setStatus("Token copied"); }
    catch { setStatus("Copy failed. Select the token manually."); }
  }

  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title={secret ? "Token Created" : "Create Token"} description={secret ? "Save this secret securely" : "Create a scoped agent credential"}>
      {secret ? (
        <div>
          <div className="break-all rounded-[6px] border border-[var(--border-strong)] bg-[var(--verifying-bg)] p-4 font-data text-[13px] leading-5" tabIndex={0}>{secret}</div>
          <p className="mt-3 text-[13px] text-[var(--verifying-text)]">Copy it now. It won&apos;t be shown again.</p>
          {status ? <p aria-live="polite" className="mt-3 text-[13px] text-[var(--fg-muted)]">{status}</p> : null}
          <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={copy}>Copy</Button><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={create} className="space-y-5">
          <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Name</span><input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="h-10 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[13px]" /></label>
          <fieldset><legend className="text-[13px] font-medium">Scopes</legend><label className="mt-3 flex items-center gap-2 border-b border-[var(--border)] pb-3 text-[13px] font-medium"><input ref={selectAllRef} type="checkbox" checked={selected.length === scopes.length} onChange={(e) => setSelected(e.target.checked ? [...scopes] : [])} className="size-4 accent-[var(--fg)]" />Select All</label><div className="space-y-3 pt-3">{scopes.map((scope) => <label key={scope} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={selected.includes(scope)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} className="size-4 accent-[var(--fg)]" /><span className="font-data">{scope}</span></label>)}</div></fieldset>
          <fieldset><legend className="mb-2 text-[13px] font-medium">Expires</legend><div className="grid grid-cols-3 gap-2">{([[30,"30 days"],[90,"90 days"],[365,"1 year"]] as const).map(([value,label]) => <label key={value} className={`flex h-10 cursor-pointer items-center justify-center rounded-[6px] border text-[13px] ${days === value ? "border-[var(--fg)] bg-[var(--chip-bg)] font-medium" : "border-[var(--border-strong)]"}`}><input type="radio" name="expiry" value={value} checked={days === value} onChange={() => setDays(value)} className="sr-only" />{label}</label>)}</div></fieldset>
          {status ? <p aria-live="polite" className="text-[13px] text-[var(--down-text)]">{status}</p> : null}
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create Token"}</Button></div>
        </form>
      )}
    </Sheet>
  );
}
