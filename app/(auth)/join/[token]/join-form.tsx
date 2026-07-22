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
  const passwordRef = useRef<HTMLInputElement>(null)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    const data = new FormData(event.currentTarget)
    try {
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
      if (!response.ok) {
        const message = body.error || "Join failed"
        setError(message)
        // Send focus to the field the error is about. Errors naming neither
        // field (an expired invite, a server fault) leave focus where it is
        // and the alert announcement carries the message.
        if (/password/i.test(message)) {
          passwordRef.current?.focus()
        } else if (/email/i.test(message)) {
          emailRef.current?.focus()
        }
        setBusy(false)
        return
      }
      // busy stays true through the redirect so the button never snaps back
      // to idle while the browser is navigating away.
      location.assign(body.redirect ?? "/")
    } catch {
      setError("Couldn't reach the server. Check your connection and try again")
      // Disabling the submit button dropped focus to the body, restore an
      // anchor so keyboard users can retry without hunting.
      emailRef.current?.focus()
      setBusy(false)
    }
  }
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>Join Pulse</p>
      <h1 className={styles.title}>Create your account</h1>
      <p className={styles.lede}>
        You were invited as {role === "admin" ? "an admin" : "a viewer"}
      </p>
      <Card className={styles.card}>
        <form onSubmit={submit}>
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
                maxLength={128}
                minLength={12}
                name="password"
                ref={passwordRef}
                required
                type="password"
              />
            </Field>
            <Field htmlFor="passwordConfirmation" label="Confirm password">
              <Input
                autoComplete="new-password"
                id="passwordConfirmation"
                maxLength={128}
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
