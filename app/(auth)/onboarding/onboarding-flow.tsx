"use client"

import { ArrowLeft, Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import useSWR from "swr"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import { timezoneOptions } from "@/components/settings/timezone-control"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { CheckResult } from "@/lib/checker"
import type { MonitorDraft, OnboardingStep } from "@/lib/onboarding/service"
import type { ReadinessReport } from "@/lib/readiness/types"

import styles from "../auth.module.css"

type Step = "readiness" | "account" | OnboardingStep
interface Props {
  initialStep: Step
  initialDraft?: MonitorDraft
  email?: string
  initialEmailWarningAcknowledged?: boolean
}

async function post(path: string, body: unknown = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || "Request failed"), {
      payload,
    })
  }
  return payload
}

export function OnboardingFlow({
  initialStep,
  initialDraft,
  email = "",
  initialEmailWarningAcknowledged = false,
}: Props) {
  const [step, setStep] = useState<Step>(initialStep)
  const [draft, setDraft] = useState<MonitorDraft>(
    initialDraft ?? { url: "", name: "", alertEmail: email }
  )
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [canStartAnyway, setCanStartAnyway] = useState(false)
  const [emailWarningAcknowledged, setEmailWarningAcknowledged] = useState(
    initialEmailWarningAcknowledged
  )
  const [accountCreated, setAccountCreated] = useState(
    initialStep !== "readiness"
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function back(target: "monitor" | "verify") {
    setError("")
    await post("/api/onboarding/back", { step: target })
    setStep(target)
  }
  if (step === "readiness") {
    return (
      <Readiness
        onContinue={(acknowledged) => {
          setEmailWarningAcknowledged(acknowledged)
          setStep(accountCreated ? "monitor" : "account")
        }}
      />
    )
  }
  if (step === "account") {
    return (
      <Account
        emailWarningAcknowledged={emailWarningAcknowledged}
        onBack={() => setStep("readiness")}
        onCreated={(accountEmail) => {
          setAccountCreated(true)
          setDraft((value) => ({ ...value, alertEmail: accountEmail }))
          setStep("monitor")
        }}
      />
    )
  }
  if (step === "monitor") {
    return (
      <MonitorStep
        busy={busy}
        draft={draft}
        error={error}
        onBack={() => setStep("readiness")}
        onSubmit={async (next) => {
          setBusy(true)
          setError("")
          try {
            const payload = await post("/api/onboarding/draft", next)
            setDraft(payload.draft)
            const verified = await post("/api/onboarding/verify")
            setCheck(verified.result)
            setCanStartAnyway(verified.canStartAnyway)
            setStep("verify")
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Website validation failed"
            )
          } finally {
            setBusy(false)
          }
        }}
      />
    )
  }
  if (step === "verify") {
    return (
      <VerifyStep
        busy={busy}
        canStartAnyway={canStartAnyway}
        draft={draft}
        emailWarningAcknowledged={emailWarningAcknowledged}
        error={error}
        onBack={() => void back("monitor")}
        onStart={async (alertEmail) => {
          setBusy(true)
          setError("")
          try {
            await post("/api/onboarding/activate", {
              alertEmail,
              startAnyway: canStartAnyway,
            })
            setStep("getting_started")
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not start monitoring"
            )
          } finally {
            setBusy(false)
          }
        }}
        result={check}
      />
    )
  }
  return <GettingStarted />
}

function Progress({ step }: { step: number }) {
  return (
    <div
      aria-valuemax={3}
      aria-valuemin={1}
      aria-valuenow={step}
      className={styles.progress}
      role="progressbar"
    >
      {[1, 2, 3].map((n) => (
        <span className={n <= step ? styles.active : ""} key={n} />
      ))}
    </div>
  )
}

function Readiness({
  onContinue,
}: {
  onContinue: (acknowledged: boolean) => void
}) {
  const {
    data: report,
    isLoading: loading,
    mutate,
  } = useSWR<ReadinessReport>(
    "/api/onboarding/readiness",
    async (url: string) => {
      const response = await fetch(url, { cache: "no-store" })
      if (!response.ok) {
        throw new Error("Readiness failed")
      }
      return response.json()
    }
  )
  const [visible, setVisible] = useState(0)
  function replay() {
    setVisible(0)
    void mutate()
  }
  useEffect(() => {
    if (!report) {
      return
    }
    const timer = setInterval(
      () =>
        setVisible((n) => {
          if (n >= 4) {
            clearInterval(timer)
            return n
          }
          return n + 1
        }),
      180
    )
    return () => clearInterval(timer)
  }, [report])
  const names = {
    vercel: ["Vercel", "Deployment and environment"],
    database: ["Database", "Neon connection and migrations"],
    edge: ["Edge Config", "Configuration read and write"],
    email: ["Email", "Resend sender verification"],
  } as const
  const blocked = report?.checks.find((item) => item.state === "blocked")
  const warning = report?.checks.find((item) => item.state === "warning")
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>System Check</p>
      <h1 className={styles.title}>Make sure Pulse is ready</h1>
      <p className={styles.lede}>
        Verify required services before creating your account
      </p>
      <Card className={styles.card}>
        <h2 className={styles.cardTitle}>System Readiness</h2>
        <p className={styles.cardCopy}>
          Checks your existing deployment configuration
        </p>
        <div aria-live="polite" className={styles.systems}>
          {Object.entries(names).map(([key, labels], index) => {
            const result = report?.checks.find((item) => item.system === key)
            const shown = index < visible
            const active = loading ? index === 0 : report && index === visible
            const state = shown ? result?.state : active ? "checking" : "queued"
            return (
              <div
                className={`${styles.system} ${styles[state || "queued"]}`}
                key={key}
              >
                <span className={styles.dot} />
                <div>
                  <div className={styles.systemName}>{labels[0]}</div>
                  <div className={styles.systemDetail}>{labels[1]}</div>
                </div>
                <span>
                  {state === "checking" ? (
                    <span className={styles.spinner} />
                  ) : state === "ready" ? (
                    <Check className={styles.check} size={18} />
                  ) : state === "warning" ? (
                    <span className={styles.statusWarning}>Warning</span>
                  ) : state === "blocked" ? (
                    <span className={styles.statusBlocked}>Blocked</span>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
        {blocked ? (
          <div
            className={`${styles.notice} ${styles.blockNotice}`}
            role="alert"
          >
            {blocked.remediation}
          </div>
        ) : warning ? (
          <div className={`${styles.notice} ${styles.warnNotice}`}>
            Email alerts are unavailable until Resend is ready
          </div>
        ) : null}
        <div className={styles.stacked}>
          <Button disabled={loading} onClick={replay} variant="secondary">
            Check Again
          </Button>
          <Button
            disabled={!report?.canContinue || visible < 4}
            onClick={() => onContinue(Boolean(warning))}
          >
            {warning ? "Continue Without Alerts" : "Continue to Account"}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function Account({
  emailWarningAcknowledged,
  onBack,
  onCreated,
}: {
  emailWarningAcknowledged: boolean
  onBack: () => void
  onCreated: (email: string) => void
}) {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const name = String(data.get("name")).trim()
    const email = String(data.get("email"))
    const password = String(data.get("password"))
    const confirmation = String(data.get("confirmation"))
    const bootstrapToken = String(data.get("bootstrapToken")).trim()
    if (password !== confirmation) {
      setError("Passwords do not match")
      return
    }
    setBusy(true)
    setError("")
    try {
      await post("/api/onboarding/account", {
        name: name || undefined,
        email,
        password,
        passwordConfirmation: confirmation,
        acknowledgeEmailWarning: emailWarningAcknowledged,
        bootstrapToken,
      })
      onCreated(email.trim().toLowerCase())
    } catch (cause) {
      const err = cause as Error & { payload?: { redirect?: string } }
      if (err.payload?.redirect) {
        location.assign(err.payload.redirect)
        return
      }
      setError(err.message)
      first.current?.focus()
    } finally {
      setBusy(false)
    }
  }
  return (
    <StepFrame
      eyebrow="Step 1 of 3"
      lede="Set up secure dashboard access"
      number={1}
      title="Create your admin account"
    >
      <form onSubmit={submit}>
        <div className={styles.fields}>
          <Field
            description="Optional. Shown in the user menu."
            htmlFor="name"
            label="Name"
          >
            <Input
              autoComplete="name"
              id="name"
              maxLength={120}
              name="name"
              ref={first}
              type="text"
            />
          </Field>
          <Field htmlFor="email" label="Email">
            <Input
              autoComplete="email"
              id="email"
              name="email"
              required
              type="email"
            />
          </Field>
          <Field
            description="Use at least 12 characters. Password managers work well."
            htmlFor="password"
            label="Password"
          >
            <Input
              autoComplete="new-password"
              id="password"
              maxLength={128}
              minLength={12}
              name="password"
              required
              type="password"
            />
          </Field>
          <Field htmlFor="confirmation" label="Confirm Password">
            <Input
              aria-describedby={
                error === "Passwords do not match"
                  ? "account-step-error"
                  : undefined
              }
              aria-invalid={error === "Passwords do not match" || undefined}
              autoComplete="new-password"
              id="confirmation"
              name="confirmation"
              required
              type="password"
            />
          </Field>
          <Field
            description="The PULSE_BOOTSTRAP_TOKEN you set in this deployment's environment. Proves you are the operator."
            htmlFor="bootstrapToken"
            label="Setup Token"
          >
            <Input
              autoComplete="off"
              id="bootstrapToken"
              name="bootstrapToken"
              required
              type="password"
            />
          </Field>
        </div>
        {error ? (
          <p className={styles.error} id="account-step-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button
            aria-label="Back"
            onClick={onBack}
            size="icon"
            variant="secondary"
          >
            <ArrowLeft size={16} />
          </Button>
          <Button disabled={busy} type="submit">
            {busy ? "Creating…" : "Create Account"}
          </Button>
        </div>
      </form>
    </StepFrame>
  )
}

function TimezoneField() {
  // Single-writer model: onboarding runs before any device-override affordance
  // exists, so the picker writes the account (server) value, never a device key.
  const { serverTimezone, resolvedTimeZone, setServerTimezone } = useTimezone()
  const value = serverTimezone ?? "system"
  const options = timezoneOptions.some((zone) => zone.value === value)
    ? timezoneOptions
    : [...timezoneOptions, { label: value, value }]
  function commit(next: string) {
    setServerTimezone(next === "system" ? null : next)
    void fetch("/api/v1/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: next === "system" ? null : next }),
    }).catch(() => undefined)
  }
  return (
    <Field
      description={
        value === "system"
          ? `Detected from this device · ${resolvedTimeZone}`
          : "Saved to your account for dashboard timestamps."
      }
      htmlFor="timezone"
      label="Time Zone"
    >
      <Select onValueChange={commit} value={value}>
        <SelectTrigger aria-label="Time zone" id="timezone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((zone) => (
            <SelectItem key={zone.value} value={zone.value}>
              {zone.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function MonitorStep({
  draft,
  error,
  busy,
  onBack,
  onSubmit,
}: {
  draft: MonitorDraft
  error: string
  busy: boolean
  onBack?: () => void
  onSubmit: (draft: MonitorDraft) => void
}) {
  const [url, setUrl] = useState(draft.url)
  const [name, setName] = useState(draft.name)
  const [nameEdited, setNameEdited] = useState(Boolean(draft.name))
  return (
    <StepFrame
      eyebrow="Step 2 of 3"
      lede="Add the endpoint Pulse should watch"
      number={2}
      title="Monitor your first website"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit({ url, name, alertEmail: draft.alertEmail })
        }}
      >
        <div className={styles.fields}>
          <Field htmlFor="url" label="Website URL">
            <Input
              id="url"
              onChange={(e) => {
                setUrl(e.target.value)
                if (!nameEdited) {
                  try {
                    setName(
                      new URL(e.target.value).hostname.replace(/^www\./, "")
                    )
                  } catch {
                    setName("")
                  }
                }
              }}
              placeholder="https://superposition.app"
              required
              type="url"
              value={url}
            />
          </Field>
          <Field htmlFor="name" label="Monitor Name">
            <Input
              id="name"
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value)
                setNameEdited(true)
              }}
              required
              value={name}
            />
          </Field>
          <TimezoneField />
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          {onBack ? (
            <Button
              aria-label="Back"
              onClick={onBack}
              size="icon"
              variant="secondary"
            >
              <ArrowLeft size={16} />
            </Button>
          ) : null}
          <Button disabled={busy} type="submit">
            {busy ? "Testing…" : "Test Website"}
          </Button>
        </div>
      </form>
    </StepFrame>
  )
}

function VerifyStep({
  draft,
  result,
  emailWarningAcknowledged,
  error,
  busy,
  canStartAnyway,
  onBack,
  onStart,
}: {
  draft: MonitorDraft
  result: CheckResult | null
  emailWarningAcknowledged: boolean
  error: string
  busy: boolean
  canStartAnyway: boolean
  onBack: () => void
  onStart: (email: string) => void
}) {
  const [alertEmail, setAlertEmail] = useState(draft.alertEmail || "")
  return (
    <StepFrame
      eyebrow="Step 3 of 3"
      lede="Review the check before monitoring begins"
      number={3}
      title="Verify and start monitoring"
    >
      {result ? (
        <div
          className={`${styles.result} ${result.success ? "" : styles.failed}`}
        >
          <div>
            <div className={styles.resultTitle}>
              {result.success
                ? "Website responded successfully"
                : result.errorCode}
            </div>
            <div className={styles.resultMeta}>
              {result.hostname} ·{" "}
              {result.resolvedAddress || "No public address"}
              {result.statusCode ? ` · HTTP ${result.statusCode}` : ""}
            </div>
          </div>
          <span className={styles.resultMeta}>{result.latencyMs} ms</span>
        </div>
      ) : (
        <div className={styles.result}>
          <div className={styles.resultTitle}>
            Check will run before activation
          </div>
        </div>
      )}
      <Field
        description={
          emailWarningAcknowledged
            ? "Alerts are disabled until email is ready"
            : undefined
        }
        htmlFor="alert-email"
        label="Alert Email"
      >
        <Input
          disabled={emailWarningAcknowledged}
          id="alert-email"
          onChange={(e) => setAlertEmail(e.target.value)}
          type="email"
          value={emailWarningAcknowledged ? "" : alertEmail}
        />
      </Field>
      <div className={styles.summary}>
        <div className={styles.summaryRow}>
          <span>Check interval</span>
          <span>Every minute</span>
        </div>
        <div className={styles.summaryRow}>
          <span>Expected response</span>
          <span>HTTP 200–399</span>
        </div>
        <div className={styles.summaryRow}>
          <span>Confirm outage</span>
          <span>After 2 failures</span>
        </div>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          aria-label="Back"
          onClick={onBack}
          size="icon"
          variant="secondary"
        >
          <ArrowLeft size={16} />
        </Button>
        <Button
          disabled={
            busy || Boolean(result && !result.success && !canStartAnyway)
          }
          onClick={() => onStart(alertEmail)}
        >
          {busy
            ? "Starting…"
            : canStartAnyway
              ? "Start Monitoring Anyway"
              : "Start Monitoring"}
        </Button>
      </div>
    </StepFrame>
  )
}

function GettingStarted() {
  const origin =
    typeof location === "undefined"
      ? "https://pulse.superposition.app"
      : location.origin
  const command = `go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest\npulsectl me --server ${origin}`
  const prompt =
    "Use pulsectl --help to discover commands. Authenticate through PULSECTL_TOKEN, prefer --output json, and never print or persist the token."
  async function open() {
    await post("/api/onboarding/complete")
    location.assign("/")
  }
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>Getting Started</p>
      <h1 className={styles.title}>Take Pulse beyond the dashboard</h1>
      <p className={styles.lede}>
        Use pulsectl to manage monitors from your terminal and give agents
        narrowly scoped access
      </p>
      <Card className={styles.card}>
        <CopySection
          code={command}
          copy="Install the CLI and link this Pulse server"
          title="Install pulsectl"
        />
        <CopySection
          code={prompt}
          copy="Create a scoped token, then share this prompt"
          title="Give an agent access"
        />
        <p className={styles.cardCopy}>
          Create tokens in Settings → API Tokens
        </p>
        <div className={styles.gettingActions}>
          <a className={styles.link} href="/docs/cli">
            View CLI Documentation
          </a>
          <Button onClick={() => void open()}>Open Dashboard</Button>
        </div>
      </Card>
    </div>
  )
}

function CopySection({
  title,
  copy,
  code,
}: {
  title: string
  copy: string
  code: string
}) {
  const [copied, setCopied] = useState(false)
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      const area = document.createElement("textarea")
      area.value = code
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.append(area)
      area.select()
      document.execCommand("copy")
      area.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <section className={styles.copySection}>
      <h2 className={styles.copyHead}>{title}</h2>
      <p className={styles.copyText}>{copy}</p>
      <div className={styles.copyWrap}>
        <pre className={styles.copyCode}>{code}</pre>
        <Button
          className={styles.copyButton}
          onClick={() => void copyCode()}
          size="sm"
          variant="secondary"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </section>
  )
}

function StepFrame({
  number,
  eyebrow,
  title,
  lede,
  children,
}: {
  number: number
  eyebrow: string
  title: string
  lede: string
  children: React.ReactNode
}) {
  return (
    <div className={styles.flow}>
      <Progress step={number} />
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lede}>{lede}</p>
      <Card className={styles.card}>{children}</Card>
    </div>
  )
}
