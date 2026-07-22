"use client"

import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import styles from "../../auth.module.css"

export function JoinForm({ role, token }: { role: string; token: string }) {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    const data = new FormData(event.currentTarget)
    const response = await fetch("/api/auth/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
        passwordConfirmation: data.get("passwordConfirmation"),
      }),
    })
    const body = (await response.json()) as {
      redirect?: string
      error?: string
    }
    setBusy(false)
    if (!response.ok) {
      setError(body.error || "Join failed")
      emailRef.current?.focus()
      return
    }
    location.assign(body.redirect ?? "/")
  }
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>Join Pulse</p>
      <h1 className={styles.title}>Create your account</h1>
      <p className={styles.lede}>
        You were invited as {role === "admin" ? "an admin" : "a viewer"}
      </p>
      <Card className={styles.card}>
        <form noValidate onSubmit={submit}>
          <div className={styles.fields}>
            <Field htmlFor="name" label="Name">
              <Input autoComplete="name" id="name" name="name" type="text" />
            </Field>
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
                autoComplete="new-password"
                id="password"
                minLength={12}
                name="password"
                required
                type="password"
              />
            </Field>
            <Field htmlFor="passwordConfirmation" label="Confirm password">
              <Input
                autoComplete="new-password"
                id="passwordConfirmation"
                minLength={12}
                name="passwordConfirmation"
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
            {busy ? "Creating Account…" : "Create Account"}
          </Button>
        </form>
      </Card>
    </div>
  )
}
