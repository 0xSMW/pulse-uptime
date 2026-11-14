import "server-only"

import { eq, inArray } from "drizzle-orm"
import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  adminUsers,
  apiTokens,
  cliInstallations,
  cliSessions,
} from "@/lib/db/schema"
import type { IncidentExclusionRecord } from "./exclusions"

export interface AttributedIncidentExclusion extends IncidentExclusionRecord {
  createdByLabel: string
  revertedByLabel: string | null
}

type ActorType = "human" | "api_token" | "cli_session"
const principalPattern =
  /^(human|api_token|cli_session):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const fallbacks: Record<ActorType, string> = {
  human: "Former user",
  api_token: "Deleted API token",
  cli_session: "Former CLI session",
}

function parsePrincipal(principal: string) {
  const match = principalPattern.exec(principal)
  if (!(match && match[1]! in fallbacks)) {
    return null
  }
  return { type: match[1] as ActorType, id: match[2]!.toLowerCase() }
}

export async function withExclusionAttribution(
  rows: IncidentExclusionRecord[],
  handle: DatabaseHandle = db
): Promise<AttributedIncidentExclusion[]> {
  const ids: Record<ActorType, Set<string>> = {
    human: new Set(),
    api_token: new Set(),
    cli_session: new Set(),
  }
  for (const row of rows) {
    for (const principal of [row.createdByPrincipal, row.revertedByPrincipal]) {
      const actor = principal ? parsePrincipal(principal) : null
      if (actor) {
        ids[actor.type].add(actor.id)
      }
    }
  }

  const [users, tokens, sessions] = await Promise.all([
    ids.human.size
      ? handle
          .select({
            id: adminUsers.id,
            name: adminUsers.name,
            email: adminUsers.email,
          })
          .from(adminUsers)
          .where(inArray(adminUsers.id, [...ids.human]))
      : [],
    ids.api_token.size
      ? handle
          .select({ id: apiTokens.id, name: apiTokens.name })
          .from(apiTokens)
          .where(inArray(apiTokens.id, [...ids.api_token]))
      : [],
    ids.cli_session.size
      ? handle
          .select({
            id: cliSessions.id,
            name: adminUsers.name,
            email: adminUsers.email,
          })
          .from(cliSessions)
          .innerJoin(
            cliInstallations,
            eq(cliInstallations.id, cliSessions.installationId)
          )
          .leftJoin(adminUsers, eq(adminUsers.id, cliInstallations.userId))
          .where(inArray(cliSessions.id, [...ids.cli_session]))
      : [],
  ])
  const labels = new Map<string, string>()
  for (const user of users) {
    labels.set(
      `human:${user.id}`,
      user.name?.trim() || user.email.trim() || fallbacks.human
    )
  }
  for (const token of tokens) {
    labels.set(
      `api_token:${token.id}`,
      token.name.trim()
        ? `${token.name.trim()} (API token)`
        : fallbacks.api_token
    )
  }
  for (const session of sessions) {
    const user = session.name?.trim() || session.email?.trim()
    labels.set(
      `cli_session:${session.id}`,
      user ? `${user} (CLI)` : fallbacks.cli_session
    )
  }
  function label(principal: string): string {
    const actor = parsePrincipal(principal)
    return actor
      ? (labels.get(`${actor.type}:${actor.id}`) ?? fallbacks[actor.type])
      : "Unknown actor"
  }
  return rows.map((row) => ({
    ...row,
    createdByLabel: label(row.createdByPrincipal),
    revertedByLabel:
      row.revertedByPrincipal === null ? null : label(row.revertedByPrincipal),
  }))
}
