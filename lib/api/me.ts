import type { Principal } from "./principal"

export type PrincipalProfile = {
  name: string | null
  timezone: string | null
  avatarImageId: string | null
}

export function serializePrincipal(
  principal: Principal,
  profile: PrincipalProfile | null = null
) {
  switch (principal.type) {
    case "human":
      return {
        principalType: principal.type,
        email: principal.email,
        tokenId: null,
        tokenName: null,
        scopes: principal.scopes,
        installation: null,
        name: profile?.name ?? null,
        timezone: profile?.timezone ?? null,
        avatarImageId: profile?.avatarImageId ?? null,
      }
    case "api_token":
      return {
        principalType: principal.type,
        email: null,
        tokenId: principal.id,
        tokenName: principal.name,
        scopes: principal.scopes,
        installation: null,
        name: null,
        timezone: null,
        avatarImageId: null,
      }
    case "cli_session":
      return {
        principalType: principal.type,
        email: principal.email,
        tokenId: null,
        tokenName: null,
        scopes: principal.scopes,
        installation: {
          id: principal.installation.id,
          name: principal.installation.displayName,
          platform: principal.installation.platform,
          arch: principal.installation.architecture,
          clientVersion: principal.installation.clientVersion,
          linkedAt: principal.installation.linkedAt.toISOString(),
        },
        name: null,
        timezone: null,
        avatarImageId: null,
      }
  }
}
