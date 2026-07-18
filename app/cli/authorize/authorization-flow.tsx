"use client";

import { useState, useTransition } from "react";
import { Check, KeyRound, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import {
  approveAuthorization,
  denyAuthorization,
  lookupAuthorization,
  type AuthorizationRequestView,
} from "./actions";
import styles from "./authorize.module.css";

const PERMISSIONS = [
  "Manage monitors",
  "View incidents and private status",
  "View and apply configuration",
  "Send test notifications",
  "Manage API tokens",
] as const;

type Props = {
  accountEmail: string;
  initialCode?: string;
  initialError?: string;
  initialRequest?: AuthorizationRequestView;
};

export function AuthorizationFlow({ accountEmail, initialCode = "", initialError = "", initialRequest }: Props) {
  const [request, setRequest] = useState<AuthorizationRequestView | null>(initialRequest ?? null);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState(initialError);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<Awaited<ReturnType<typeof lookupAuthorization>>>) {
    setError("");
    startTransition(async () => {
      const response = await action();
      if (!response.ok) {
        if (response.signedOut) {
          const returnTo = `${window.location.pathname}${window.location.search}`;
          window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
          return;
        }
        setError(response.message);
        return;
      }
      if ("request" in response) setRequest(response.request);
      if ("state" in response) setResult(response.state);
    });
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("userCode") ?? "");
    run(() => lookupAuthorization(value));
  }

  if (result) return <ReplacementState state={result} />;

  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>CLI access</p>
      <h1 className={styles.title}>Authorize pulsectl</h1>
      <p className={styles.lede}>Link this installation to your Pulse account</p>

      <Card className={styles.card}>
        {request ? (
          <>
            <div className={styles.client}>
              <span className={styles.clientIcon} aria-hidden="true"><span className={styles.statusDot} /></span>
              <div className={styles.clientCopy}>
                <h2>{request.clientName} · {request.installationName}</h2>
                <p>{request.installationName} wants full access to <span>{accountEmail}</span></p>
                <p className={styles.meta}>{request.clientVersion} · {request.platform}/{request.architecture}</p>
              </div>
            </div>

            <div className={styles.permissions} aria-label="Requested permissions">
              {PERMISSIONS.map((permission) => (
                <div className={styles.permission} key={permission}>
                  <Check size={14} aria-hidden="true" />
                  <span>{permission}</span>
                </div>
              ))}
            </div>

            <div className={styles.codeConfirmation}>
              <KeyRound size={16} aria-hidden="true" />
              <div>
                <p className={styles.code}>{request.userCode}</p>
                <p>Matches the code shown in your terminal</p>
              </div>
            </div>

            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button className={styles.action} variant="secondary" disabled={pending} onClick={() => run(() => denyAuthorization(request.userCode))}>
                {pending ? "Working…" : "Cancel"}
              </Button>
              <Button className={styles.action} disabled={pending} onClick={() => run(() => approveAuthorization(request.userCode))}>
                {pending ? "Working…" : "Authorize"}
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submitCode}>
            <div className={styles.lookupIcon} aria-hidden="true"><ShieldCheck size={18} /></div>
            <h2 className={styles.lookupTitle}>Enter your authorization code</h2>
            <p className={styles.lookupCopy}>Paste the code or complete URL from pulsectl</p>
            <label className={styles.label} htmlFor="user-code">Authorization code</label>
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
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <Button className={styles.continue} type="submit" disabled={pending}>
              {pending ? "Checking…" : "Continue"}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

function ReplacementState({ state }: { state: "approved" | "denied" }) {
  const approved = state === "approved";
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>CLI access</p>
      <h1 className={styles.title}>Authorize pulsectl</h1>
      <Card className={styles.replacement} role="status">
        <span className={approved ? styles.successDot : styles.neutralDot} aria-hidden="true" />
        <div>
          <h2>{approved ? "Installation linked" : "Request cancelled"}</h2>
          <p>{approved ? "Return to your terminal" : "No access was granted"}</p>
        </div>
      </Card>
    </div>
  );
}
