import type { Principal } from "./principal";

export function serializePrincipal(principal: Principal) {
  switch (principal.type) {
    case "human":
      return {
        principalType: principal.type,
        email: principal.email,
        tokenId: null,
        tokenName: null,
        scopes: principal.scopes,
        installation: null,
      };
    case "api_token":
      return {
        principalType: principal.type,
        email: null,
        tokenId: principal.id,
        tokenName: principal.name,
        scopes: principal.scopes,
        installation: null,
      };
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
      };
  }
}
