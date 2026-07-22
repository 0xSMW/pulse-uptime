"use client"

import { useState } from "react"

export function SignOutButton() {
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      // Reloading the join page re-evaluates the session server side, so the
      // invite form renders immediately after the sign-out.
      window.location.reload()
    } catch {
      setSigningOut(false)
    }
  }

  return (
    <button
      className="text-sm underline underline-offset-4 disabled:opacity-60"
      disabled={signingOut}
      onClick={signOut}
      type="button"
    >
      {signingOut ? "Signing out…" : "Sign out and use this invite"}
    </button>
  )
}
