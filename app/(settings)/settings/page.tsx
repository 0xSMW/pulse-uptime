import { redirect } from "next/navigation"

// Fallback only. The primary redirect lives in next.config.ts redirects().
export default function SettingsPage() {
  redirect("/settings/account")
}
