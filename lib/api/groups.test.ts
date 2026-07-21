import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: { impl: "default-db" } }))
vi.mock("./config-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-mutation")>()),
  mutateConfig: vi.fn(
    async (
      _principalKey: string,
      mutator: (config: MonitoringConfig) => MonitoringConfig
    ) => mutator(seededConfig())
  ),
}))

import {
  createMonitorWithDefaults,
  DEFAULT_MONITOR_SETTINGS,
  type MonitoringConfig,
} from "@/lib/config"
import type { DatabaseHandle } from "@/lib/db/client"
import { db } from "@/lib/db/client"
import { mutateConfig } from "./config-mutation"
import {
  addGroup,
  createGroup,
  deleteGroup,
  GroupApiError,
  removeGroup,
  renameGroup,
  updateGroup,
} from "./groups"

const base = (): MonitoringConfig => ({
  schemaVersion: 2,
  configVersion: 1,
  settings: { ...DEFAULT_MONITOR_SETTINGS },
  groups: [],
  monitors: [],
})

/** Seed config used only by the mutateConfig-mock-backed handle-threading tests below: a preexisting "production" group so update/delete reach the success path. */
function seededConfig(): MonitoringConfig {
  return { ...base(), groups: [{ id: "production", name: "Production" }] }
}

describe("group configuration mutations", () => {
  it("creates and renames an empty group without changing monitor references", () => {
    const created = addGroup(base(), { id: "production", name: "Production" })
    const renamed = renameGroup(created, "production", { name: "Core" })
    expect(renamed.groups).toEqual([{ id: "production", name: "Core" }])
    expect(renamed.configVersion).toBe(3)
  })

  it("enforces case-insensitive name uniqueness", () => {
    const created = addGroup(base(), { id: "production", name: "Production" })
    expect(() =>
      addGroup(created, { id: "other", name: "production" })
    ).toThrow(GroupApiError)
  })

  it("deletes empty groups and blocks referenced groups", () => {
    const created = addGroup(base(), { id: "production", name: "Production" })
    expect(removeGroup(created, "production").groups).toEqual([])
    const referenced = {
      ...created,
      monitors: [
        {
          ...createMonitorWithDefaults({
            id: "website",
            name: "Website",
            url: "https://example.com",
          }),
          groupId: "production",
        },
      ],
    }
    expect(() => removeGroup(referenced, "production")).toThrowError(
      expect.objectContaining({
        code: "GROUP_NOT_EMPTY",
        details: { monitorCount: 1 },
      })
    )
  })
})

describe("handle threading to mutateConfig (finding: the mutation and the idempotency completion must commit in the same transaction, so the route's tx must reach mutateConfig, not the default pool)", () => {
  const routeTx = { impl: "route-tx" } as unknown as DatabaseHandle

  it("createGroup forwards the given handle", async () => {
    await createGroup({ id: "staging", name: "Staging" }, "human:1", routeTx)
    expect(mutateConfig).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      routeTx
    )
  })

  it("createGroup defaults to the db handle when none is given", async () => {
    await createGroup({ id: "staging", name: "Staging" }, "human:1")
    expect(mutateConfig).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      db
    )
  })

  it("updateGroup forwards the given handle", async () => {
    await updateGroup("production", { name: "Core" }, "human:1", routeTx)
    expect(mutateConfig).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      routeTx
    )
  })

  it("deleteGroup forwards the given handle", async () => {
    await deleteGroup("production", "human:1", routeTx)
    expect(mutateConfig).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      routeTx
    )
  })
})
