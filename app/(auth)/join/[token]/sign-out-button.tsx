"use client"

import { useState } from "react"

export function SignOutButton() {
  const [signingOut, setSigningOut] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signOut() {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    setFailed(false)
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" })
      if (!response.ok) {
        throw new Error("logout rejected")
      }
      // Reloading the join page re-evaluates the session server side, so the
      // invite form renders immediately after the sign-out.
      window.location.reload()
    } catch {
      setSigningOut(false)
      setFailed(true)
    }
  }

  return (
    <>
      <button
        className="text-sm underline underline-offset-4 disabled:opacity-60"
        disabled={signingOut}
        onClick={signOut}
        type="button"
      >
        {signingOut ? "Signing out…" : "Sign out and use this invite"}
      </button>
      {failed ? (
        <p className="mt-2 text-[var(--fg-muted)] text-sm" role="alert">
          Sign-out failed. Try again, or sign out from the dashboard.
        </p>
      ) : null}
    </>
  )
}
