"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { CliCard } from "@/components/settings/cli-card";
import { apiRequest, messageForError } from "@/components/settings/settings-api";
import { CardHeading } from "@/components/settings/settings-row";
import { TokenSheet } from "@/components/settings/token-sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTimezone } from "@/components/dashboard/timezone-provider";
import { formatRelativeTime } from "@/lib/reporting/format";

export type AccessSettingsData = {
  tokens: Array<{ id: string; name: string; kind: "agent" | "cli"; detail: string | null; prefix: string; scopes: string[]; expiresAt: string; lastUsedAt: string | null }>;
  origin: string;
};

const VISIBLE_SCOPES = 3;

function ScopeChips({ scopes }: { scopes: string[] }) {
  const visible = scopes.slice(0, VISIBLE_SCOPES);
  const overflow = scopes.length - visible.length;
  return (
    <div className="flex max-w-[360px] items-center gap-1 whitespace-nowrap">
      {visible.map((scope) => (
        <span key={scope} className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px]">{scope}</span>
      ))}
      {overflow > 0 ? (
        <span
          title={scopes.join(", ")}
          aria-label={`${overflow} more ${overflow === 1 ? "scope" : "scopes"}: ${scopes.slice(VISIBLE_SCOPES).join(", ")}`}
          className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px] text-[var(--fg-muted)]"
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

function formatExpiry(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone }).format(date);
}

export function AccessSettings({ data }: { data: AccessSettingsData }) {
  const router = useRouter();
  const { resolvedTimeZone } = useTimezone();
  const [tokenSheet, setTokenSheet] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenStatus, setTokenStatus] = useState("");

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
      <Card className="overflow-hidden"><CardHeading title="API Tokens" action={<Button variant="primary" size="sm" onClick={() => setTokenSheet(true)}>Create Token</Button>} /><div className="hide-scrollbar overflow-x-auto border-t border-[var(--border)]"><table className="w-full min-w-[500px] border-collapse text-left text-[13px] md:min-w-[760px]"><thead className="text-xs text-[var(--fg-muted)]"><tr className="h-10 border-b border-[var(--border)]"><th className="px-6 font-medium">Name</th><th className="px-4 font-medium max-lg:hidden">Token</th><th className="px-4 font-medium max-md:hidden">Scopes</th><th className="px-4 font-medium">Expires</th><th className="px-4 font-medium max-xl:hidden">Last Used</th><th className="px-6 text-right font-medium"><span className="sr-only">Actions</span></th></tr></thead><tbody>{data.tokens.map((token) => <tr key={`${token.kind}-${token.id}`} className="h-[60px] border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"><td className="px-6"><div className="max-w-[240px] truncate font-medium" title={token.name}>{token.name}</div><div className="max-w-[240px] truncate text-xs whitespace-nowrap text-[var(--fg-faint)]">{token.kind === "agent" ? "Agent token" : `CLI session${token.detail ? ` · ${token.detail}` : ""}`}</div></td><td className="px-4 font-data text-xs text-[var(--fg-muted)] max-lg:hidden">{token.prefix}····</td><td className="px-4 max-md:hidden"><ScopeChips scopes={token.scopes} /></td><td className="px-4 whitespace-nowrap font-data text-xs text-[var(--fg-muted)]">{formatExpiry(token.expiresAt, resolvedTimeZone)}</td><td className="px-4 whitespace-nowrap font-data text-xs text-[var(--fg-muted)] max-xl:hidden">{token.lastUsedAt ? formatRelativeTime(new Date(token.lastUsedAt), new Date(), resolvedTimeZone) : "Never"}</td><td className="px-6 text-right">{token.kind === "agent" ? <>{revokeId === token.id ? <span className="inline-flex items-center gap-2"><span className="text-xs text-[var(--down-text)]">Revoke?</span><Button variant="secondary" size="sm" onClick={() => setRevokeId(null)} disabled={tokenBusy}>Cancel</Button><Button variant="secondary" size="sm" onClick={() => revokeToken(token.id)} disabled={tokenBusy}>{tokenBusy ? "Revoking…" : "Confirm"}</Button></span> : <Button variant="secondary" size="sm" onClick={() => setRevokeId(token.id)}>Revoke</Button>}</> : <span className="text-xs text-[var(--fg-faint)]">Linked session</span>}</td></tr>)}</tbody></table>{data.tokens.length === 0 ? <div className="px-6 py-12 text-center"><p className="font-medium">No API tokens</p><p className="mt-1 text-[13px] text-[var(--fg-muted)]">Create a token for agents and CI</p></div> : null}</div>{tokenStatus ? <p className="border-t border-[var(--border)] px-6 py-3 text-[13px] text-[var(--fg-muted)]" aria-live="polite">{tokenStatus}</p> : null}</Card>

      <Card><CardHeading title="CLI" /><CardContent className="pt-0"><CliCard origin={data.origin} /></CardContent></Card>

      {tokenSheet ? <TokenSheet open onClose={() => setTokenSheet(false)} /> : null}
    </div>
  );
}
