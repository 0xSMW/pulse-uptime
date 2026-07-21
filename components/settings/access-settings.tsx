"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { useTimezone } from "@/components/dashboard/timezone-provider"
import { CliCard } from "@/components/settings/cli-card"
import { apiRequest, messageForError } from "@/components/settings/settings-api"
import { CardHeading } from "@/components/settings/settings-row"
import { TokenSheet } from "@/components/settings/token-sheet"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { formatRelativeTime } from "@/lib/reporting/format"

export interface AccessSettingsData {
  tokens: Array<{
    id: string
    name: string
    kind: "agent" | "cli"
    detail: string | null
    prefix: string
    scopes: string[]
    expiresAt: string
    lastUsedAt: string | null
  }>
  origin: string
}

const VISIBLE_SCOPES = 3

function ScopeChips({ scopes }: { scopes: string[] }) {
  const visible = scopes.slice(0, VISIBLE_SCOPES)
  const overflow = scopes.length - visible.length
  return (
    <div className="flex max-w-[360px] items-center gap-1 whitespace-nowrap">
      {visible.map((scope) => (
        <span
          className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px]"
          key={scope}
        >
          {scope}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          aria-label={`${overflow} more ${overflow === 1 ? "scope" : "scopes"}: ${scopes.slice(VISIBLE_SCOPES).join(", ")}`}
          className="rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-data text-[11px] text-[var(--fg-muted)]"
          title={scopes.join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  )
}

function formatExpiry(value: string, timeZone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return "—"
  }
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(date)
}

export function AccessSettings({ data }: { data: AccessSettingsData }) {
  const router = useRouter()
  const { resolvedTimeZone } = useTimezone()
  const [tokenSheet, setTokenSheet] = useState(false)
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenStatus, setTokenStatus] = useState("")

  async function revokeToken(id: string) {
    setTokenBusy(true)
    setTokenStatus("")
    try {
      await apiRequest(
        `/api/v1/tokens/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        true
      )
      setRevokeId(null)
      setTokenStatus("Token revoked")
      router.refresh()
    } catch (error) {
      setTokenStatus(messageForError(error))
    } finally {
      setTokenBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeading
          action={
            <Button
              onClick={() => setTokenSheet(true)}
              size="sm"
              variant="primary"
            >
              Create Token
            </Button>
          }
          title="API Tokens"
        />
        <div className="hide-scrollbar overflow-x-auto border-[var(--border)] border-t">
          <table className="w-full min-w-[500px] border-collapse text-left text-[13px] md:min-w-[760px]">
            <thead className="text-[var(--fg-muted)] text-xs">
              <tr className="h-10 border-[var(--border)] border-b">
                <th className="px-6 font-medium">Name</th>
                <th className="px-4 font-medium max-lg:hidden">Token</th>
                <th className="px-4 font-medium max-md:hidden">Scopes</th>
                <th className="px-4 font-medium">Expires</th>
                <th className="px-4 font-medium max-xl:hidden">Last Used</th>
                <th className="px-6 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((token) => (
                <tr
                  className="h-[60px] border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                  key={`${token.kind}-${token.id}`}
                >
                  <td className="px-6">
                    <div
                      className="max-w-[240px] truncate font-medium"
                      title={token.name}
                    >
                      {token.name}
                    </div>
                    <div className="max-w-[240px] truncate whitespace-nowrap text-[var(--fg-faint)] text-xs">
                      {token.kind === "agent"
                        ? "Agent token"
                        : `CLI session${token.detail ? ` · ${token.detail}` : ""}`}
                    </div>
                  </td>
                  <td className="px-4 font-data text-[var(--fg-muted)] text-xs max-lg:hidden">
                    {token.prefix}····
                  </td>
                  <td className="px-4 max-md:hidden">
                    <ScopeChips scopes={token.scopes} />
                  </td>
                  <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs">
                    {formatExpiry(token.expiresAt, resolvedTimeZone)}
                  </td>
                  <td className="whitespace-nowrap px-4 font-data text-[var(--fg-muted)] text-xs max-xl:hidden">
                    {token.lastUsedAt
                      ? formatRelativeTime(
                          new Date(token.lastUsedAt),
                          new Date(),
                          resolvedTimeZone
                        )
                      : "Never"}
                  </td>
                  <td className="px-6 text-right">
                    {token.kind === "agent" ? (
                      revokeId === token.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-[var(--down-text)] text-xs">
                            Revoke?
                          </span>
                          <Button
                            disabled={tokenBusy}
                            onClick={() => setRevokeId(null)}
                            size="sm"
                            variant="secondary"
                          >
                            Cancel
                          </Button>
                          <Button
                            disabled={tokenBusy}
                            onClick={() => revokeToken(token.id)}
                            size="sm"
                            variant="secondary"
                          >
                            {tokenBusy ? "Revoking…" : "Confirm"}
                          </Button>
                        </span>
                      ) : (
                        <Button
                          onClick={() => setRevokeId(token.id)}
                          size="sm"
                          variant="secondary"
                        >
                          Revoke
                        </Button>
                      )
                    ) : (
                      <span className="text-[var(--fg-faint)] text-xs">
                        Linked session
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.tokens.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="font-medium">No API tokens</p>
              <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
                Create a token for agents and CI
              </p>
            </div>
          ) : null}
        </div>
        {tokenStatus ? (
          <p
            aria-live="polite"
            className="border-[var(--border)] border-t px-6 py-3 text-[13px] text-[var(--fg-muted)]"
          >
            {tokenStatus}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeading title="CLI" />
        <CardContent className="pt-0">
          <CliCard origin={data.origin} />
        </CardContent>
      </Card>

      {tokenSheet ? (
        <TokenSheet onClose={() => setTokenSheet(false)} open />
      ) : null}
    </div>
  )
}
