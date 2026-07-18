"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import styles from "../auth.module.css";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: data.get("email"), password: data.get("password"), returnTo }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setError("Sign in failed"); emailRef.current?.focus(); return; }
    location.assign(body.redirect);
  }
  return <div className={styles.flow}>
    <p className={styles.eyebrow}>Welcome back</p><h1 className={styles.title}>Sign in to Pulse</h1><p className={styles.lede}>Manage monitors and incidents</p>
    <Card className={styles.card}><form onSubmit={submit} noValidate>
      <div className={styles.fields}>
        <Field label="Email" htmlFor="email"><Input ref={emailRef} id="email" name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
      </div>{error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <Button className="mt-6 w-full" type="submit" disabled={busy}>{busy ? "Signing In…" : "Sign In"}</Button>
    </form></Card>
  </div>;
}
