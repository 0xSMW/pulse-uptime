import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/analytics-server", () => ({ trackEvent: vi.fn() }))

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const verify = databaseUrl
  ? postgres(databaseUrl, { max: 1, prepare: false })
  : null
const hashKey = "join-route-test-key-with-at-least-32-characters"
const runId = crypto.randomUUID().replaceAll("-", "")
const inviteIds: string[] = []
const emails: string[] = []
let requestIndex = 0
let POST: typeof import("./route").POST
let closeRouteDatabase: (() => Promise<void>) | undefined

function email(label: string): string {
  const value = `${label}-${runId}@example.test`
  emails.push(value)
  return value
}

function request(body: unknown, origin = "https://pulse.example"): Request {
  requestIndex += 1
  return new Request("https://pulse.example/api/auth/join", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-real-ip": `203.0.113.${requestIndex}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const password = "long-enough-test-password"
function joinBody(token: string, address: string, role?: string) {
  return {
    token,
    email: address,
    password,
    passwordConfirmation: password,
    name: "Invitee",
    ...(role ? { role } : {}),
  }
}

async function seedInvite(options: {
  role: "admin" | "viewer"
  expired?: boolean
  revoked?: boolean
}) {
  const { createBearerToken } = await import("@/lib/api/tokens")
  const credential = createBearerToken("pulse_join_")
  const id = crypto.randomUUID()
  inviteIds.push(id)
  const now = Date.now()
  const createdAt = new Date(now - 2 * 60 * 60 * 1000)
  const expiresAt = new Date(now + (options.expired ? -1 : 60) * 60 * 1000)
  await verify!`
    insert into user_invites
      (id, token_digest, role, created_by_principal, created_at, expires_at, revoked_at)
    values
      (${id}, ${credential.digest}, ${options.role}, ${`human:${crypto.randomUUID()}`},
       ${createdAt}, ${expiresAt}, ${options.revoked ? new Date() : null})
  `
  return { id, token: credential.raw }
}

suite("POST /api/auth/join with real invite persistence", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl!)
    vi.stubEnv("API_TOKEN_HASH_KEY", hashKey)
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pulse.example")
    ;({ POST } = await import("./route"))
    const { sql } = await import("@/lib/db/client")
    closeRouteDatabase = () => sql.end()
  })

  afterAll(async () => {
    if (verify) {
      await verify`
        delete from human_sessions
        where user_id in (select id from admin_users where email = any(${emails}))
      `
      await verify`delete from user_invites where id = any(${inviteIds})`
      await verify`delete from admin_users where email = any(${emails})`
      await verify.end()
    }
    await closeRouteDatabase?.()
    vi.unstubAllEnvs()
  })

  it("rejects malformed JSON and an unknown invite without issuing a session", async () => {
    const malformed = await POST(request("{"))
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get("set-cookie")).toBeNull()

    const missing = await POST(
      request(joinBody("pulse_join_missing", email("missing")))
    )
    expect(missing.status).toBe(410)
    expect(missing.headers.get("set-cookie")).toBeNull()
    await expect(missing.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired",
    })
  })

  it.each([
    { state: "expired", expired: true },
    { state: "revoked", revoked: true },
  ])("rejects a $state invite without creating a user", async (options) => {
    const invite = await seedInvite({ role: "admin", ...options })
    const address = email(options.state)
    const response = await POST(request(joinBody(invite.token, address)))

    expect(response.status).toBe(410)
    expect(response.headers.get("set-cookie")).toBeNull()
    const [user] =
      await verify!`select id from admin_users where email = ${address}`
    expect(user).toBeUndefined()
  })

  it("uses the stored role and atomically accepts an admin invite once", async () => {
    const invite = await seedInvite({ role: "admin" })
    const firstEmail = email("winner")
    const secondEmail = email("loser")
    const [first, second] = await Promise.all([
      POST(request(joinBody(invite.token, firstEmail, "viewer"))),
      POST(request(joinBody(invite.token, secondEmail, "viewer"))),
    ])

    expect([first.status, second.status].sort()).toEqual([200, 410])
    const winner = first.status === 200 ? first : second
    const loser = first.status === 410 ? first : second
    expect(winner.headers.get("set-cookie")).toContain("__Host-pulse_session=")
    expect(loser.headers.get("set-cookie")).toBeNull()
    const users = await verify!`
      select id, email, role from admin_users
      where email = any(${[firstEmail, secondEmail]})
    `
    expect(users).toHaveLength(1)
    expect(users[0]?.role).toBe("admin")
    const [claimed] = await verify!`
      select accepted_at, accepted_by_user_id from user_invites where id = ${invite.id}
    `
    expect(claimed?.accepted_at).toBeTruthy()
    expect(claimed?.accepted_by_user_id).toBe(users[0]?.id)
    const sessions = await verify!`
      select id from human_sessions where user_id = ${users[0]?.id}
    `
    expect(sessions).toHaveLength(1)
  })

  it("does not promote a viewer invite when the request claims admin", async () => {
    const invite = await seedInvite({ role: "viewer" })
    const address = email("viewer")

    const response = await POST(
      request(joinBody(invite.token, address, "admin"))
    )

    expect(response.status).toBe(200)
    const [user] = await verify!`
      select role from admin_users where email = ${address}
    `
    expect(user?.role).toBe("viewer")
  })

  it("returns 409 for a duplicate email and leaves the invite usable", async () => {
    const address = email("duplicate")
    const userId = crypto.randomUUID()
    await verify!`
      insert into admin_users
        (id, email, password_digest, role, created_at, updated_at, password_changed_at)
      values
        (${userId}, ${address}, 'test-digest', 'viewer', now(), now(), now())
    `
    const invite = await seedInvite({ role: "admin" })

    const response = await POST(request(joinBody(invite.token, address)))

    expect(response.status).toBe(409)
    expect(response.headers.get("set-cookie")).toBeNull()
    const [claim] = await verify!`
      select accepted_at from user_invites where id = ${invite.id}
    `
    expect(claim?.accepted_at).toBeNull()
  })
})
