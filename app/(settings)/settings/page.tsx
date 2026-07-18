import { redirect } from "next/navigation";

// Fallback only — the primary redirect lives in next.config.ts redirects().
export default function SettingsPage() {
  redirect("/settings/account");
}
