"use client"

import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import styles from "../auth.module.css"

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    const data = new FormData(event.currentTarget)
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"),
        password: data.get("password"),
        returnTo,
      }),
    })
    const body = await response.json()
    setBusy(false)
    if (!response.ok) {
      setError("Sign in failed")
      emailRef.current?.focus()
      return
    }
    location.assign(body.redirect)
  }
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>Welcome back</p>
      <h1 className={styles.title}>Sign in to Pulse</h1>
      <p className={styles.lede}>Manage monitors and incidents</p>
      <Card className={styles.card}>
        <form noValidate onSubmit={submit}>
          <div className={styles.fields}>
            <Field htmlFor="email" label="Email">
              <Input
                autoComplete="email"
                id="email"
                name="email"
                ref={emailRef}
                required
                type="email"
              />
            </Field>
            <Field htmlFor="password" label="Password">
              <Input
                autoComplete="current-password"
                id="password"
                name="password"
                required
                type="password"
              />
            </Field>
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <Button className="mt-6 w-full" disabled={busy} type="submit">
            {busy ? "Signing In…" : "Sign In"}
          </Button>
        </form>
      </Card>
    </div>
  )
}
