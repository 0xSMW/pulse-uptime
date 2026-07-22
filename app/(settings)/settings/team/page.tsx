import { Suspense } from "react"

import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"
import { TeamSettings } from "@/components/settings/team-settings"
import { listTeam } from "@/lib/auth/invites"
import { requireAdminSettings } from "@/lib/auth/require-admin"

export default function TeamSettingsPage() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">Team</h1>
      <Suspense
        fallback={
          <SettingsCardsSkeleton
            heights={["h-[280px]", "h-40"]}
            label="Loading team settings"
          />
        }
      >
        <TeamSettingsIsland />
      </Suspense>
    </>
  )
}

async function TeamSettingsIsland() {
  const session = await requireAdminSettings()
  const team = await listTeam()
  return (
    <TeamSettings
      data={{
        currentUserId: session.userId,
        origin: process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "",
        users: team.users.map((user) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt.toISOString(),
          lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
        })),
        invites: team.invites.map((invite) => ({
          id: invite.id,
          role: invite.role,
          createdAt: invite.createdAt.toISOString(),
          expiresAt: invite.expiresAt.toISOString(),
        })),
      }}
    />
  )
}
