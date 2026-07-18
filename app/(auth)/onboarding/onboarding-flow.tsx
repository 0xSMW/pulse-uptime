"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ReadinessReport } from "@/lib/readiness/types";
import type { CheckResult } from "@/lib/checker";
import type { MonitorDraft, OnboardingStep } from "@/lib/onboarding/service";

import styles from "../auth.module.css";

type Step = "readiness" | "account" | OnboardingStep;
type Props = { initialStep: Step; initialDraft?: MonitorDraft; email?: string; alertsDisabled?: boolean };

async function post(path: string, body: unknown = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || "Request failed"), { payload });
  return payload;
}

export function OnboardingFlow({ initialStep, initialDraft, email = "", alertsDisabled = false }: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  const [draft, setDraft] = useState<MonitorDraft>(initialDraft ?? { url: "", name: "", alertEmail: email });
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [canStartAnyway, setCanStartAnyway] = useState(false);
  const [emailWarningAcknowledged, setEmailWarningAcknowledged] = useState(alertsDisabled);
  const [accountCreated, setAccountCreated] = useState(initialStep !== "readiness");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function back(target: "monitor" | "verify") {
    setError(""); await post("/api/onboarding/back", { step: target }); setStep(target);
  }
  if (step === "readiness") return <Readiness onContinue={(acknowledged) => { setEmailWarningAcknowledged(acknowledged); setStep(accountCreated ? "monitor" : "account"); }} />;
  if (step === "account") return <Account acknowledgeEmailWarning={emailWarningAcknowledged} onBack={() => setStep("readiness")} onCreated={(accountEmail) => { setAccountCreated(true); setDraft((value) => ({ ...value, alertEmail: accountEmail })); setStep("monitor"); }} />;
  if (step === "monitor") return <MonitorStep draft={draft} error={error} busy={busy} onBack={() => setStep("readiness")} onSubmit={async (next) => {
    setBusy(true); setError(""); try { const payload = await post("/api/onboarding/draft", next); setDraft(payload.draft); const verified = await post("/api/onboarding/verify"); setCheck(verified.result); setCanStartAnyway(verified.canStartAnyway); setStep("verify"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Website validation failed"); } finally { setBusy(false); }
  }} />;
  if (step === "verify") return <VerifyStep draft={draft} result={check} alertsDisabled={emailWarningAcknowledged} error={error} busy={busy} canStartAnyway={canStartAnyway} onBack={() => void back("monitor")} onStart={async (alertEmail) => {
    setBusy(true); setError(""); try { await post("/api/onboarding/activate", { alertEmail, startAnyway: canStartAnyway }); setStep("getting_started"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start monitoring"); } finally { setBusy(false); }
  }} />;
  return <GettingStarted />;
}

function Progress({ step }: { step: number }) { return <div className={styles.progress} role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step}>{[1,2,3].map((n) => <span key={n} className={n <= step ? styles.active : ""} />)}</div>; }

function Readiness({ onContinue }: { onContinue: (acknowledged: boolean) => void }) {
  const { data: report, isLoading: loading, mutate } = useSWR<ReadinessReport>("/api/onboarding/readiness", async (url: string) => { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error("Readiness failed"); return response.json(); });
  const [visible, setVisible] = useState(0);
  function replay() { setVisible(0); void mutate(); }
  useEffect(() => { if (!report) return; const timer = setInterval(() => setVisible((n) => { if (n >= 4) { clearInterval(timer); return n; } return n + 1; }), 180); return () => clearInterval(timer); }, [report]);
  const names = { vercel: ["Vercel", "Deployment and environment"], database: ["Database", "Neon connection and migrations"], edge: ["Edge Config", "Configuration read and write"], email: ["Email", "Resend sender verification"] } as const;
  const blocked = report?.checks.find((item) => item.state === "blocked"); const warning = report?.checks.find((item) => item.state === "warning");
  return <div className={styles.flow}><p className={styles.eyebrow}>System Check</p><h1 className={styles.title}>Make sure Pulse is ready</h1><p className={styles.lede}>Verify required services before creating your account</p>
    <Card className={styles.card}><h2 className={styles.cardTitle}>System Readiness</h2><p className={styles.cardCopy}>Checks your existing deployment configuration</p>
      <div className={styles.systems} aria-live="polite">{Object.entries(names).map(([key, labels], index) => { const result = report?.checks.find((item) => item.system === key); const shown = index < visible; const active = loading ? index === 0 : report && index === visible; const state = shown ? result?.state : active ? "checking" : "queued"; return <div key={key} className={`${styles.system} ${styles[state || "queued"]}`}><span className={styles.dot}/><div><div className={styles.systemName}>{labels[0]}</div><div className={styles.systemDetail}>{labels[1]}</div></div><span>{state === "checking" ? <span className={styles.spinner}/> : state === "ready" ? <Check size={18} className={styles.check}/> : state === "warning" ? <span className={styles.statusWarning}>Warning</span> : state === "blocked" ? <span className={styles.statusBlocked}>Blocked</span> : null}</span></div>; })}</div>
      {blocked ? <div role="alert" className={`${styles.notice} ${styles.blockNotice}`}>{blocked.remediation}</div> : warning ? <div className={`${styles.notice} ${styles.warnNotice}`}>Email alerts are unavailable until Resend is ready</div> : null}
      <div className={styles.stacked}><Button variant="secondary" onClick={replay} disabled={loading}>Check Again</Button><Button disabled={!report?.canContinue || visible < 4} onClick={() => onContinue(Boolean(warning))}>{warning ? "Continue Without Alerts" : "Continue to Account"}</Button></div>
    </Card></div>;
}

function Account({ acknowledgeEmailWarning, onBack, onCreated }: { acknowledgeEmailWarning: boolean; onBack: () => void; onCreated: (email: string) => void }) {
  const [error,setError]=useState(""); const [busy,setBusy]=useState(false); const first=useRef<HTMLInputElement>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); const data=new FormData(event.currentTarget); const email=String(data.get("email")); const password=String(data.get("password")); const confirmation=String(data.get("confirmation")); if(password!==confirmation){setError("Passwords do not match");return;} setBusy(true);setError("");try{await post("/api/onboarding/account",{email,password,passwordConfirmation:confirmation,acknowledgeEmailWarning});onCreated(email.trim().toLowerCase());}catch(cause){const err=cause as Error & {payload?:{redirect?:string}};if(err.payload?.redirect){location.assign(err.payload.redirect);return;}setError(err.message);first.current?.focus();}finally{setBusy(false);} }
  return <StepFrame number={1} eyebrow="Step 1 of 3" title="Create your admin account" lede="Set up secure dashboard access"><form onSubmit={submit}><div className={styles.fields}><Field label="Email" htmlFor="email"><Input ref={first} id="email" name="email" type="email" autoComplete="email" required/></Field><Field label="Password" htmlFor="password" description="Use at least 12 characters. Password managers work well."><Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></Field><Field label="Confirm Password" htmlFor="confirmation"><Input id="confirmation" name="confirmation" type="password" autoComplete="new-password" required/></Field></div>{error?<p className={styles.error} role="alert">{error}</p>:null}<div className={styles.actions}><Button size="icon" variant="secondary" aria-label="Back" onClick={onBack}><ArrowLeft size={16}/></Button><Button type="submit" disabled={busy}>{busy?"Creating…":"Create Account"}</Button></div></form></StepFrame>;
}

function MonitorStep({draft,error,busy,onBack,onSubmit}:{draft:MonitorDraft;error:string;busy:boolean;onBack?:()=>void;onSubmit:(draft:MonitorDraft)=>void}) {
  const [url,setUrl]=useState(draft.url); const [name,setName]=useState(draft.name); const [nameEdited,setNameEdited]=useState(Boolean(draft.name));
  return <StepFrame number={2} eyebrow="Step 2 of 3" title="Monitor your first website" lede="Add the endpoint Pulse should watch"><form onSubmit={(e)=>{e.preventDefault();onSubmit({url,name,alertEmail:draft.alertEmail});}}><div className={styles.fields}><Field label="Website URL" htmlFor="url"><Input id="url" type="url" value={url} placeholder="https://example.com" onChange={(e)=>{setUrl(e.target.value);if(!nameEdited){try{setName(new URL(e.target.value).hostname.replace(/^www\./,""));}catch{setName("");}}}} required/></Field><Field label="Monitor Name" htmlFor="name"><Input id="name" value={name} onChange={(e)=>{setName(e.target.value);setNameEdited(true);}} maxLength={80} required/></Field></div>{error?<p className={styles.error} role="alert">{error}</p>:null}<div className={styles.actions}>{onBack?<Button size="icon" variant="secondary" aria-label="Back" onClick={onBack}><ArrowLeft size={16}/></Button>:null}<Button type="submit" disabled={busy}>{busy?"Testing…":"Test Website"}</Button></div></form></StepFrame>;
}

function VerifyStep({draft,result,alertsDisabled,error,busy,canStartAnyway,onBack,onStart}:{draft:MonitorDraft;result:CheckResult|null;alertsDisabled:boolean;error:string;busy:boolean;canStartAnyway:boolean;onBack:()=>void;onStart:(email:string)=>void}) { const [alertEmail,setAlertEmail]=useState(draft.alertEmail||""); return <StepFrame number={3} eyebrow="Step 3 of 3" title="Verify and start monitoring" lede="Review the check before monitoring begins">{result?<div className={`${styles.result} ${result.success?"":styles.failed}`}><div><div className={styles.resultTitle}>{result.success?"Website responded successfully":result.errorCode}</div><div className={styles.resultMeta}>{result.hostname} · {result.resolvedAddress||"No public address"}{result.statusCode?` · HTTP ${result.statusCode}`:""}</div></div><span className={styles.resultMeta}>{result.latencyMs} ms</span></div>:<div className={styles.result}><div className={styles.resultTitle}>Check will run before activation</div></div>}<Field label="Alert Email" htmlFor="alert-email" description={alertsDisabled?"Alerts are disabled until email is ready":undefined}><Input id="alert-email" type="email" value={alertsDisabled?"":alertEmail} onChange={(e)=>setAlertEmail(e.target.value)} disabled={alertsDisabled}/></Field><div className={styles.summary}><div className={styles.summaryRow}><span>Check interval</span><span>Every minute</span></div><div className={styles.summaryRow}><span>Expected response</span><span>HTTP 200–399</span></div><div className={styles.summaryRow}><span>Confirm outage</span><span>After 2 failures</span></div></div>{error?<p className={styles.error} role="alert">{error}</p>:null}<div className={styles.actions}><Button size="icon" variant="secondary" aria-label="Back" onClick={onBack}><ArrowLeft size={16}/></Button><Button disabled={busy||Boolean(result&&!result.success&&!canStartAnyway)} onClick={()=>onStart(alertEmail)}>{busy?"Starting…":canStartAnyway?"Start Monitoring Anyway":"Start Monitoring"}</Button></div></StepFrame>; }

function GettingStarted() { const origin=typeof location==="undefined"?"https://pulse.example.com":location.origin; const command=`brew install smw/tap/pulsectl\npulsectl me --server ${origin}`; const prompt="Use pulsectl --help to discover commands. Authenticate through PULSECTL_TOKEN, prefer --output json, and never print or persist the token."; async function open(){await post("/api/onboarding/complete");location.assign("/");} return <div className={styles.flow}><p className={styles.eyebrow}>Getting Started</p><h1 className={styles.title}>Take Pulse beyond the dashboard</h1><p className={styles.lede}>Use pulsectl to manage monitors from your terminal and give agents narrowly scoped access</p><Card className={styles.card}><CopySection title="Install pulsectl" copy="Install the CLI and link this Pulse server" code={command}/><CopySection title="Give an agent access" copy="Create a scoped token, then share this prompt" code={prompt}/><p className={styles.cardCopy}>Create tokens in Settings → API Tokens</p><div className={styles.gettingActions}><a className={styles.link} href="/docs/cli">View CLI Documentation</a><Button onClick={()=>void open()}>Open Dashboard</Button></div></Card></div>; }

function CopySection({title,copy,code}:{title:string;copy:string;code:string}) { const [copied,setCopied]=useState(false); async function copyCode(){try{await navigator.clipboard.writeText(code);}catch{const area=document.createElement("textarea");area.value=code;area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();document.execCommand("copy");area.remove();}setCopied(true);setTimeout(()=>setCopied(false),2000);} return <section className={styles.copySection}><h2 className={styles.copyHead}>{title}</h2><p className={styles.copyText}>{copy}</p><div className={styles.copyWrap}><pre className={styles.copyCode}>{code}</pre><Button className={styles.copyButton} variant="secondary" size="sm" onClick={()=>void copyCode()}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?"Copied":"Copy"}</Button></div></section>; }

function StepFrame({number,eyebrow,title,lede,children}:{number:number;eyebrow:string;title:string;lede:string;children:React.ReactNode}) { return <div className={styles.flow}><Progress step={number}/><p className={styles.eyebrow}>{eyebrow}</p><h1 className={styles.title}>{title}</h1><p className={styles.lede}>{lede}</p><Card className={styles.card}>{children}</Card></div>; }
