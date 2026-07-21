import { describe, expect, it } from "vitest"
import type {
  DependencyCatalogCategory,
  DependencyCatalogPreset,
} from "@/lib/dependencies/queries"
import type { ScopeSelection } from "@/lib/dependencies/types"
import {
  ALL_LOCATIONS_VALUE,
  categoryLabel,
  filterCatalogCategories,
  scopeDiscoveryMessage,
  scopeSelectValue,
  selectedScopeForPreset,
  showsScopeSelector,
} from "./add-dependency-sheet"

function preset(
  overrides: Partial<DependencyCatalogPreset> &
    Pick<DependencyCatalogPreset, "id" | "scopeSelection">
): DependencyCatalogPreset {
  return {
    name: overrides.id,
    provider: "Provider",
    description: "",
    sourceScopeNote: null,
    fidelity: "component",
    enabled: true,
    validated: true,
    hasValidationError: false,
    installed: false,
    installedScopeIds: [],
    ...overrides,
  }
}

const categories: DependencyCatalogCategory[] = [
  {
    category: "ai",
    presets: [
      preset({
        id: "openai_api",
        name: "OpenAI API",
        provider: "OpenAI",
        scopeSelection: null,
      }),
      preset({
        id: "chatgpt",
        name: "ChatGPT",
        provider: "OpenAI",
        scopeSelection: null,
      }),
    ],
  },
  {
    category: "data",
    presets: [
      preset({
        id: "neon_database",
        name: "Neon Database",
        provider: "Neon",
        scopeSelection: {
          required: true,
          allowsUnscoped: false,
          status: "static",
          options: [
            { id: "aws-us-east-1", label: "AWS us-east-1", available: true },
          ],
        },
      }),
    ],
  },
]

describe("filterCatalogCategories", () => {
  it("returns every category unchanged for an empty query", () => {
    expect(filterCatalogCategories(categories, "")).toEqual(categories)
    expect(filterCatalogCategories(categories, "   ")).toEqual(categories)
  })

  it("matches by preset name, case-insensitively", () => {
    const result = filterCatalogCategories(categories, "chatgpt")
    expect(result).toHaveLength(1)
    expect(result[0].presets.map((entry) => entry.id)).toEqual(["chatgpt"])
  })

  it("matches by provider name", () => {
    const result = filterCatalogCategories(categories, "neon")
    expect(result).toHaveLength(1)
    expect(result[0].category).toBe("data")
  })

  it("matches across multiple presets within a category", () => {
    const result = filterCatalogCategories(categories, "openai")
    expect(result).toHaveLength(1)
    expect(result[0].presets).toHaveLength(2)
  })

  it("drops categories left with no matching presets", () => {
    const result = filterCatalogCategories(categories, "stripe")
    expect(result).toEqual([])
  })
})

describe("categoryLabel", () => {
  it("maps known category slugs to their display labels", () => {
    expect(categoryLabel("ai")).toBe("AI")
    expect(categoryLabel("hosting")).toBe("Hosting and network")
    expect(categoryLabel("auth")).toBe("Authentication")
    expect(categoryLabel("data")).toBe("Data")
    expect(categoryLabel("payments")).toBe("Payments and communication")
    expect(categoryLabel("developer")).toBe("Developer infrastructure")
  })

  it("falls back to the raw slug for an unknown category", () => {
    expect(categoryLabel("mystery")).toBe("mystery")
  })
})

describe("selectedScopeForPreset", () => {
  const requiredDiscovered: ScopeSelection = {
    required: true,
    allowsUnscoped: false,
    status: "ready",
    options: [
      { id: "nyc1", label: "NYC1", available: true },
      { id: "sfo3", label: "SFO3", available: false },
    ],
  }

  const optionalLocations: ScopeSelection = {
    required: false,
    allowsUnscoped: true,
    status: "ready",
    options: [
      { id: "us-central1", label: "us-central1", available: true },
      { id: "europe-west1", label: "europe-west1", available: true },
    ],
  }

  const staticRequired: ScopeSelection = {
    required: true,
    allowsUnscoped: false,
    status: "static",
    options: [{ id: "aws-us-east-1", label: "AWS us-east-1", available: true }],
  }

  it("returns null scope for presets with no scopeSelection", () => {
    expect(
      selectedScopeForPreset(
        preset({ id: "openai_api", scopeSelection: null }),
        {},
        "openai_api"
      )
    ).toEqual({
      ready: true,
      scopeId: null,
    })
  })

  it("blocks required discovered selectors until an available option is chosen", () => {
    const droplets = preset({
      id: "digitalocean_droplets",
      scopeSelection: requiredDiscovered,
    })
    expect(
      selectedScopeForPreset(droplets, {}, "digitalocean_droplets")
    ).toEqual({ ready: false })
    expect(
      selectedScopeForPreset(
        droplets,
        { digitalocean_droplets: "nyc1" },
        "digitalocean_droplets"
      )
    ).toEqual({
      ready: true,
      scopeId: "nyc1",
    })
  })

  it("rejects an unavailable discovered option even if selected", () => {
    const droplets = preset({
      id: "digitalocean_droplets",
      scopeSelection: requiredDiscovered,
    })
    expect(
      selectedScopeForPreset(
        droplets,
        { digitalocean_droplets: "sfo3" },
        "digitalocean_droplets"
      )
    ).toEqual({
      ready: false,
    })
  })

  it("rejects unknown option ids", () => {
    const droplets = preset({
      id: "digitalocean_droplets",
      scopeSelection: requiredDiscovered,
    })
    expect(
      selectedScopeForPreset(
        droplets,
        { digitalocean_droplets: "bogus" },
        "digitalocean_droplets"
      )
    ).toEqual({
      ready: false,
    })
  })

  it("defaults optional location scopes to unscoped (All locations)", () => {
    const locations = preset({
      id: "google_cloud_storage",
      scopeSelection: optionalLocations,
    })
    expect(
      selectedScopeForPreset(locations, {}, "google_cloud_storage")
    ).toEqual({
      ready: true,
      scopeId: null,
    })
    expect(
      selectedScopeForPreset(
        locations,
        { google_cloud_storage: ALL_LOCATIONS_VALUE },
        "google_cloud_storage"
      )
    ).toEqual({ ready: true, scopeId: null })
  })

  it("accepts an available location when optional scopes pick a region", () => {
    const locations = preset({
      id: "google_cloud_storage",
      scopeSelection: optionalLocations,
    })
    expect(
      selectedScopeForPreset(
        locations,
        { google_cloud_storage: "us-central1" },
        "google_cloud_storage"
      )
    ).toEqual({ ready: true, scopeId: "us-central1" })
  })

  it("uses the same path for static required scopes as discovered ready scopes", () => {
    const neon = preset({ id: "neon_database", scopeSelection: staticRequired })
    expect(selectedScopeForPreset(neon, {}, "neon_database")).toEqual({
      ready: false,
    })
    expect(
      selectedScopeForPreset(
        neon,
        { neon_database: "aws-us-east-1" },
        "neon_database"
      )
    ).toEqual({
      ready: true,
      scopeId: "aws-us-east-1",
    })
  })

  it("blocks install while discovery is pending", () => {
    const pending = preset({
      id: "supabase_database",
      scopeSelection: {
        required: true,
        allowsUnscoped: false,
        status: "pending",
        options: [],
      },
    })
    expect(selectedScopeForPreset(pending, {}, "supabase_database")).toEqual({
      ready: false,
    })
    expect(
      selectedScopeForPreset(
        pending,
        { supabase_database: "anything" },
        "supabase_database"
      )
    ).toEqual({ ready: false })
  })

  it("allows optional unscoped install while discovery is still pending", () => {
    // Matches server validateScope: null scopeId does not require options.
    const pendingOptional = preset({
      id: "google_cloud_storage",
      scopeSelection: {
        required: false,
        allowsUnscoped: true,
        status: "pending",
        options: [],
      },
    })
    expect(
      selectedScopeForPreset(pendingOptional, {}, "google_cloud_storage")
    ).toEqual({
      ready: true,
      scopeId: null,
    })
    expect(
      selectedScopeForPreset(
        pendingOptional,
        { google_cloud_storage: ALL_LOCATIONS_VALUE },
        "google_cloud_storage"
      )
    ).toEqual({ ready: true, scopeId: null })
    // A concrete location still needs a completed discovery pass.
    expect(
      selectedScopeForPreset(
        pendingOptional,
        { google_cloud_storage: "us-central1" },
        "google_cloud_storage"
      )
    ).toEqual({ ready: false })
  })

  it("blocks install when discovery reports unavailable", () => {
    const unavailable = preset({
      id: "upstash_redis_regional",
      scopeSelection: {
        required: true,
        allowsUnscoped: false,
        status: "unavailable",
        options: [{ id: "us-east-1", label: "us-east-1", available: false }],
      },
    })
    expect(
      selectedScopeForPreset(unavailable, {}, "upstash_redis_regional")
    ).toEqual({ ready: false })
  })

  it("gates Enter-key submission the same way as the Add button", () => {
    // Enter and Add both call selectedScopeForPreset and only POST when ready.
    const droplets = preset({
      id: "digitalocean_droplets",
      scopeSelection: requiredDiscovered,
    })
    const before = selectedScopeForPreset(droplets, {}, "digitalocean_droplets")
    const after = selectedScopeForPreset(
      droplets,
      { digitalocean_droplets: "nyc1" },
      "digitalocean_droplets"
    )
    expect(before.ready).toBe(false)
    expect(after).toEqual({ ready: true, scopeId: "nyc1" })

    // Payload shape: ready scopeId is what both paths send (or omit when null).
    const body = after.ready
      ? after.scopeId
        ? { presetId: droplets.id, scopeId: after.scopeId }
        : { presetId: droplets.id }
      : null
    expect(body).toEqual({ presetId: "digitalocean_droplets", scopeId: "nyc1" })

    const unscoped = selectedScopeForPreset(
      preset({ id: "gcp", scopeSelection: optionalLocations }),
      {},
      "gcp"
    )
    expect(unscoped).toEqual({ ready: true, scopeId: null })
    if (unscoped.ready) {
      expect(
        unscoped.scopeId ? { scopeId: unscoped.scopeId } : { presetId: "gcp" }
      ).toEqual({
        presetId: "gcp",
      })
    }
  })
})

describe("scopeDiscoveryMessage", () => {
  it("returns catalog-data copy for pending discovery", () => {
    expect(
      scopeDiscoveryMessage({
        required: true,
        allowsUnscoped: false,
        status: "pending",
        options: [],
      })
    ).toBe("Catalog data not ready")
  })

  it("stays silent for optional unscoped while discovery is pending", () => {
    expect(
      scopeDiscoveryMessage({
        required: false,
        allowsUnscoped: true,
        status: "pending",
        options: [],
      })
    ).toBe("")
  })

  it("returns catalog-data copy for unavailable discovery", () => {
    expect(
      scopeDiscoveryMessage({
        required: true,
        allowsUnscoped: false,
        status: "unavailable",
        options: [{ id: "x", label: "X", available: false }],
      })
    ).toBe("Catalog scopes unavailable")
  })

  it("is empty when the selector can render", () => {
    expect(scopeDiscoveryMessage(null)).toBe("")
    expect(
      scopeDiscoveryMessage({
        required: true,
        allowsUnscoped: false,
        status: "ready",
        options: [{ id: "a", label: "A", available: true }],
      })
    ).toBe("")
    expect(
      scopeDiscoveryMessage({
        required: true,
        allowsUnscoped: false,
        status: "static",
        options: [{ id: "a", label: "A", available: true }],
      })
    ).toBe("")
  })
})

describe("showsScopeSelector", () => {
  it("shows for static and ready only", () => {
    expect(showsScopeSelector(null)).toBe(false)
    expect(
      showsScopeSelector({
        required: true,
        allowsUnscoped: false,
        status: "static",
        options: [],
      })
    ).toBe(true)
    expect(
      showsScopeSelector({
        required: true,
        allowsUnscoped: false,
        status: "ready",
        options: [{ id: "a", label: "A", available: true }],
      })
    ).toBe(true)
    expect(
      showsScopeSelector({
        required: true,
        allowsUnscoped: false,
        status: "pending",
        options: [],
      })
    ).toBe(false)
    expect(
      showsScopeSelector({
        required: true,
        allowsUnscoped: false,
        status: "unavailable",
        options: [{ id: "a", label: "A", available: false }],
      })
    ).toBe(false)
  })
})

describe("scopeSelectValue", () => {
  const optional: ScopeSelection = {
    required: false,
    allowsUnscoped: true,
    status: "ready",
    options: [{ id: "loc", label: "Loc", available: true }],
  }

  const required: ScopeSelection = {
    required: true,
    allowsUnscoped: false,
    status: "ready",
    options: [{ id: "nyc1", label: "NYC1", available: true }],
  }

  it("defaults optional scopes to the All locations sentinel", () => {
    expect(scopeSelectValue(optional, {}, "p")).toBe(ALL_LOCATIONS_VALUE)
  })

  it("leaves required scopes unset until the user picks an option", () => {
    expect(scopeSelectValue(required, {}, "p")).toBeUndefined()
    expect(scopeSelectValue(required, { p: "nyc1" }, "p")).toBe("nyc1")
  })
})
