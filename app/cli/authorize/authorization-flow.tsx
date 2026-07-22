"use client"

// TODO: this file is excluded from biome in biome.jsonc because the 2.5.4
// module resolver panics on it. Remove the exclusion once
// biomejs/biome#10996 ships.

import { Check, KeyRound, ShieldCheck } from "lucide-react"
import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

import {
  type AuthorizationRequestView,
  approveAuthorization,
  denyAuthorization,
  lookupAuthorization,
} from "./actions"
import styles from "./authorize.module.css"

const PLATFORM_LABELS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
}

const PERMISSIONS = [
  "Manage monitors",
  "View incidents and private status",
  "View and apply configuration",
  "Send test notifications",
  "Manage API tokens",
] as const

type Props = {
  accountEmail: string
  initialCode?: string
  initialError?: string
  initialRequest?: AuthorizationRequestView
}

export function AuthorizationFlow({
  accountEmail,
  initialCode = "",
  initialError = "",
  initialRequest,
}: Props) {
  const [request, setRequest] = useState<AuthorizationRequestView | null>(
    initialRequest ?? null
  )
  const [result, setResult] = useState<"approved" | "denied" | null>(null)
  const [error, setError] = useState(initialError)
  const [pending, startTransition] = useTransition()

  function run(
    action: () => Promise<Awaited<ReturnType<typeof lookupAuthorization>>>
  ) {
    setError("")
    startTransition(async () => {
      const response = await action()
      if (!response.ok) {
        if (response.signedOut) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.assign(
            `/login?returnTo=${encodeURIComponent(returnTo)}`
          )
          return
        }
        setError(response.message)
        return
      }
      if ("request" in response) setRequest(response.request)
      if ("state" in response) setResult(response.state)
    })
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(
      new FormData(event.currentTarget).get("userCode") ?? ""
    )
    run(() => lookupAuthorization(value))
  }

  if (result) return <ReplacementState state={result} />

  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>CLI access</p>
      <h1 className={styles.title}>Authorize pulsectl</h1>
      <p className={styles.lede}>
        Link this installation to your Pulse account
      </p>

      <Card className={styles.card}>
        {request ? (
          <>
            <div className={styles.client}>
              <span aria-hidden="true" className={styles.clientIcon}>
                <span className={styles.statusDot} />
              </span>
              <div className={styles.clientCopy}>
                <h2>
                  {request.clientName} · {request.installationName}
                </h2>
                <p>
                  {request.installationName} wants full access to{" "}
                  <span>{accountEmail}</span>
                </p>
                <p className={styles.meta}>
                  {request.clientVersion} ·{" "}
                  {PLATFORM_LABELS[request.platform] ?? request.platform}/
                  {request.architecture}
                  {request.requestIp ? ` · ${request.requestIp}` : ""}
                </p>
              </div>
            </div>

            <div
              aria-label="Requested permissions"
              className={styles.permissions}
            >
              {PERMISSIONS.map((permission) => (
                <div className={styles.permission} key={permission}>
                  <Check aria-hidden="true" size={14} />
                  <span>{permission}</span>
                </div>
              ))}
            </div>

            <div className={styles.codeConfirmation}>
              <KeyRound aria-hidden="true" size={16} />
              <div>
                <p className={styles.code}>{request.userCode}</p>
                <p>Matches the code shown in your terminal</p>
              </div>
            </div>

            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Button
                className={styles.action}
                disabled={pending}
                onClick={() => run(() => denyAuthorization(request.userCode))}
                variant="secondary"
              >
                {pending ? "Working…" : "Cancel"}
              </Button>
              <Button
                className={styles.action}
                disabled={pending}
                onClick={() =>
                  run(() => approveAuthorization(request.userCode))
                }
              >
                {pending ? "Working…" : "Authorize"}
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submitCode}>
            <div aria-hidden="true" className={styles.lookupIcon}>
              <ShieldCheck size={18} />
            </div>
            <h2 className={styles.lookupTitle}>
              Enter your authorization code
            </h2>
            <p className={styles.lookupCopy}>
              Paste the code or complete URL from pulsectl
            </p>
            <label className={styles.label} htmlFor="user-code">
              Authorization code
            </label>
            <Input
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoFocus
              className={styles.input}
              defaultValue={initialCode}
              id="user-code"
              name="userCode"
              placeholder="H7KD-PQ4M"
              spellCheck={false}
            />
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <Button
              className={styles.continue}
              disabled={pending}
              type="submit"
            >
              {pending ? "Checking…" : "Continue"}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}

function ReplacementState({ state }: { state: "approved" | "denied" }) {
  const approved = state === "approved"
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>CLI access</p>
      <h1 className={styles.title}>Authorize pulsectl</h1>
      <Card className={styles.replacement} role="status">
        <span
          aria-hidden="true"
          className={approved ? styles.successDot : styles.neutralDot}
        />
        <div>
          <h2>{approved ? "Installation linked" : "Request cancelled"}</h2>
          <p>
            {approved ? "Return to your terminal" : "No access was granted"}
          </p>
        </div>
      </Card>
    </div>
  )
}
