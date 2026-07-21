// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import type { StatusPageConfigDocument } from "@/lib/status-page/schema"

import { SettingsDirtyProvider, useSettingsDirty } from "./settings-dirty"
import {
  documentsEqual,
  mergeStatusPageDrafts,
  STATUS_PAGE_FIELDS,
  StatusPageSettings,
  toDocument,
  uploadValidationError,
} from "./status-page-settings"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const IMAGE_ID = "33333333-3333-4333-8333-333333333333"

function baseConfig(
  overrides: Partial<StatusPageConfigDocument> = {}
): StatusPageConfigDocument {
  return {
    name: "System Status",
    layout: "vertical",
    theme: "system",
    logoLightImageId: null,
    logoDarkImageId: null,
    faviconImageId: null,
    homepageUrl: null,
    contactUrl: null,
    navLinks: [],
    googleTagId: null,
    customCss: null,
    customHead: null,
    announcementEnabled: false,
    announcementMarkdown: null,
    historyDays: 90,
    uptimeDecimals: 2,
    unknownAsOperational: false,
    minIncidentSeconds: 0,
    timezone: null,
    ...overrides,
  }
}

function DirtyReader() {
  const context = useSettingsDirty()
  // biome-ignore lint/suspicious/noUnnecessaryConditions: useSettingsDirty returns null outside the provider
  return <span data-testid="dirty">{String(context?.dirty ?? false)}</span>
}

function renderSettings(
  overrides: Partial<StatusPageConfigDocument> = {},
  etag = '"1"'
) {
  return render(
    <SettingsDirtyProvider>
      <DirtyReader />
      <StatusPageSettings data={{ config: baseConfig(overrides), etag }} />
    </SettingsDirtyProvider>
  )
}

function jsonResponse(
  body: unknown,
  init: { status?: number; etag?: string } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.etag ? { ETag: init.etag } : {},
  })
}

type ResponseFactory = () => Response

// The form revalidates its etag with a GET on mount, so stubs are routed by
// method instead of call order. Each queue keeps replaying its last factory,
// and the GET queue defaults to the pristine baseline the form rendered with.
function stubFetch(
  routes: {
    get?: ResponseFactory[]
    put?: ResponseFactory[]
    post?: ResponseFactory[]
  } = {}
) {
  const queues: Record<string, ResponseFactory[]> = {
    GET: [
      ...(routes.get ?? [
        () => jsonResponse({ data: baseConfig() }, { etag: '"1"' }),
      ]),
    ],
    PUT: [...(routes.put ?? [])],
    POST: [...(routes.post ?? [])],
  }
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const queue = queues[method] ?? []
    const factory = queue.length > 1 ? queue.shift() : queue[0]
    if (!factory) {
      return Promise.reject(new Error(`no stubbed ${method} response`))
    }
    return Promise.resolve(factory())
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function methodCalls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(
    (call) => ((call[1] as RequestInit | undefined)?.method ?? "GET") === method
  )
}

describe("mergeStatusPageDrafts", () => {
  const base = baseConfig()

  it("keeps local edits and adopts unrelated server changes", () => {
    const local = baseConfig({ name: "Acme Status" })
    const server = baseConfig({
      historyDays: 30,
      contactUrl: "mailto:ops@acme.dev",
    })
    const merged = mergeStatusPageDrafts(base, local, server)
    expect(merged.name).toBe("Acme Status")
    expect(merged.historyDays).toBe(30)
    expect(merged.contactUrl).toBe("mailto:ops@acme.dev")
  })

  it("prefers the local value when both sides changed the same field", () => {
    const local = baseConfig({ name: "Acme Status" })
    const server = baseConfig({ name: "Server Status" })
    expect(mergeStatusPageDrafts(base, local, server).name).toBe("Acme Status")
  })

  it("treats navLinks as a whole-field merge", () => {
    const local = baseConfig({
      navLinks: [{ label: "Docs", url: "https://acme.dev/docs" }],
    })
    const server = baseConfig({
      navLinks: [{ label: "Blog", url: "https://acme.dev/blog" }],
    })
    expect(mergeStatusPageDrafts(base, local, server).navLinks).toEqual(
      local.navLinks
    )
  })
})

describe("StatusPageSettings save model", () => {
  it("shows one sticky save bar only when dirty and marks the shell dirty", () => {
    renderSettings()
    expect(screen.queryByText("Unsaved changes")).toBeNull()
    expect(screen.getByTestId("dirty").textContent).toBe("false")

    fireEvent.change(screen.getByLabelText("Page name"), {
      target: { value: "Acme Status" },
    })
    // The visible bar plus its always-mounted sr-only live-region announcer.
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2)
    expect(screen.getByTestId("dirty").textContent).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(screen.queryByText("Unsaved changes")).toBeNull()
    expect((screen.getByLabelText("Page name") as HTMLInputElement).value).toBe(
      "System Status"
    )
    expect(screen.getByTestId("dirty").textContent).toBe("false")
    // The bar unmounted. Focus lands on the always-mounted status region.
    expect(document.activeElement?.textContent).toBe("Changes discarded")
  })

  it("saves the whole document in a single PUT with If-Match", async () => {
    const fetchMock = stubFetch({
      put: [
        () =>
          jsonResponse(
            { data: baseConfig({ name: "Acme Status" }) },
            { etag: '"2"' }
          ),
      ],
    })
    renderSettings()

    fireEvent.change(screen.getByLabelText("Page name"), {
      target: { value: "Acme Status" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(screen.getByText("Status page settings saved")).toBeDefined()
    })
    expect(methodCalls(fetchMock, "PUT")).toHaveLength(1)
    const [url, init] = methodCalls(fetchMock, "PUT")[0]!
    expect(url).toBe("/api/v1/status-page-config")
    expect(init.method).toBe("PUT")
    expect(init.headers["If-Match"]).toBe('"1"')
    // The config PUT route requires a UUID Idempotency-Key (executeIdempotent).
    // Omitting it makes every Settings -> Status page save fail.
    expect(init.headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    const payload = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([...STATUS_PAGE_FIELDS].sort())
    expect(payload.name).toBe("Acme Status")
    expect(payload.historyDays).toBe(90)
    // Saved: the bar disappears and the shell is clean again.
    expect(screen.queryByText("Unsaved changes")).toBeNull()
    // Focus moved off the unmounted Save button to the status region.
    expect(document.activeElement?.textContent).toBe(
      "Status page settings saved"
    )
  })

  it("recovers from a 412 by merging and preserving local edits", async () => {
    const serverDocument = baseConfig({ contactUrl: "mailto:ops@acme.dev" })
    const fetchMock = stubFetch({
      get: [
        () => jsonResponse({ data: baseConfig() }, { etag: '"1"' }),
        () => jsonResponse({ data: serverDocument }, { etag: '"7"' }),
      ],
      put: [
        () => jsonResponse({ error: { message: "conflict" } }, { status: 412 }),
        () => jsonResponse({ data: serverDocument }, { etag: '"8"' }),
      ],
    })
    renderSettings()

    fireEvent.change(screen.getByLabelText("Page name"), {
      target: { value: "Acme Status" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(
        screen.getByText(
          "Settings changed elsewhere — your edits are preserved, review and save again"
        )
      ).toBeDefined()
    })
    // Local edit preserved, server-side change adopted, still dirty.
    expect((screen.getByLabelText("Page name") as HTMLInputElement).value).toBe(
      "Acme Status"
    )
    expect(
      (screen.getByLabelText("Contact URL") as HTMLInputElement).value
    ).toBe("mailto:ops@acme.dev")
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
    // The conflict notice reads as an alert, not muted success text.
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere")

    // The retry carries the refreshed ETag.
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(methodCalls(fetchMock, "PUT")).toHaveLength(2)
    })
    const [, retryInit] = methodCalls(fetchMock, "PUT")[1]!
    expect(retryInit.headers["If-Match"]).toBe('"7"')
  })

  it("adopts a fresh server document on mount while pristine, so a stale cached etag never conflicts", async () => {
    const serverDocument = baseConfig({ name: "Server Status" })
    const fetchMock = stubFetch({
      get: [() => jsonResponse({ data: serverDocument }, { etag: '"9"' })],
      put: [
        () =>
          jsonResponse(
            { data: baseConfig({ name: "Renamed" }) },
            { etag: '"10"' }
          ),
      ],
    })
    renderSettings()

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Page name") as HTMLInputElement).value
      ).toBe("Server Status")
    })
    // Adoption is silent, the form stays clean.
    expect(screen.queryByText("Unsaved changes")).toBeNull()

    fireEvent.change(screen.getByLabelText("Page name"), {
      target: { value: "Renamed" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(methodCalls(fetchMock, "PUT")).toHaveLength(1)
    })
    const [, init] = methodCalls(fetchMock, "PUT")[0]!
    expect(init.headers["If-Match"]).toBe('"9"')
  })
})

describe("StatusPageSettings navigation links", () => {
  it("caps the repeater at 8 rows", () => {
    const links = Array.from({ length: 8 }, (_, index) => ({
      label: `Link ${index + 1}`,
      url: `https://acme.dev/${index + 1}`,
    }))
    renderSettings({ navLinks: links })
    expect(screen.getAllByLabelText(/Link \d+ label/)).toHaveLength(8)
    expect(
      (screen.getByRole("button", { name: "Add Link" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it("adds and removes rows below the cap without an instant validation alert", () => {
    renderSettings()
    fireEvent.click(screen.getByRole("button", { name: "Add Link" }))
    expect(screen.getByLabelText("Link 1 label")).toBeDefined()
    // A just-added empty row must not fire an instant alert.
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.change(screen.getByLabelText("Link 1 label"), {
      target: { value: "Docs" },
    })
    // Still quiet while typing. Validation waits for a save attempt.
    expect(screen.queryByText("Every link needs a label and a URL")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Remove link 1" }))
    expect(screen.queryByLabelText("Link 1 label")).toBeNull()
  })

  it("surfaces link validation only on a save attempt and blocks the PUT", () => {
    const fetchMock = stubFetch()
    renderSettings()
    fireEvent.click(screen.getByRole("button", { name: "Add Link" }))
    fireEvent.change(screen.getByLabelText("Link 1 label"), {
      target: { value: "Docs" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("Every link needs a label and a URL")).toBeDefined()
    expect(methodCalls(fetchMock, "PUT")).toHaveLength(0)
    // Editing the links clears the save-attempt error.
    fireEvent.change(screen.getByLabelText("Link 1 URL"), {
      target: { value: "https://acme.dev/docs" },
    })
    expect(screen.queryByText("Every link needs a label and a URL")).toBeNull()
  })

  it("drops fully-empty rows on save instead of failing validation", async () => {
    const fetchMock = stubFetch({
      put: [
        () =>
          jsonResponse(
            { data: baseConfig({ name: "Acme Status" }) },
            { etag: '"2"' }
          ),
      ],
    })
    renderSettings()
    fireEvent.change(screen.getByLabelText("Page name"), {
      target: { value: "Acme Status" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add Link" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(screen.getByText("Status page settings saved")).toBeDefined()
    })
    const [, init] = methodCalls(fetchMock, "PUT")[0]!
    const payload = JSON.parse(init.body as string) as { navLinks: unknown[] }
    expect(payload.navLinks).toEqual([])
  })
})

describe("StatusPageSettings uploads", () => {
  it("uploads pre-save and commits only the returned id via the draft", async () => {
    const fetchMock = stubFetch({
      post: [() => jsonResponse({ data: { id: IMAGE_ID } }, { status: 201 })],
      put: [
        () =>
          jsonResponse(
            { data: baseConfig({ logoLightImageId: IMAGE_ID }) },
            { etag: '"2"' }
          ),
      ],
    })
    renderSettings()

    const file = new File(["png-bytes"], "logo.png", { type: "image/png" })
    fireEvent.change(screen.getByLabelText("Logo (light theme)"), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByText("Ready — save to apply")).toBeDefined()
    })
    const [uploadUrl, uploadInit] = methodCalls(fetchMock, "POST")[0]!
    expect(uploadUrl).toBe("/api/v1/images")
    expect(uploadInit.method).toBe("POST")
    expect((uploadInit.body as FormData).get("kind")).toBe("logo-light")

    // The reference only commits through the page-level PUT.
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(screen.getByText("Status page settings saved")).toBeDefined()
    })
    const [, putInit] = methodCalls(fetchMock, "PUT")[0]!
    const payload = JSON.parse(putInit.body as string) as Record<
      string,
      unknown
    >
    expect(payload.logoLightImageId).toBe(IMAGE_ID)
  })

  it("surfaces upload failures inline without dirtying the draft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { message: "favicon images must be at most 32 KB" } },
          { status: 400 }
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    renderSettings()

    const file = new File(["big"], "favicon.png", { type: "image/png" })
    fireEvent.change(screen.getByLabelText("Favicon"), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(
        screen.getByText("favicon images must be at most 32 KB")
      ).toBeDefined()
    })
    expect(screen.queryByText("Unsaved changes")).toBeNull()
  })

  it("rejects wrong types and oversized files before any network round-trip", () => {
    const fetchMock = stubFetch()
    renderSettings()

    fireEvent.change(screen.getByLabelText("Logo (light theme)"), {
      target: {
        files: [new File(["plain"], "notes.txt", { type: "text/plain" })],
      },
    })
    expect(
      screen.getByText("Use a PNG, JPEG, SVG, or WebP image.")
    ).toBeDefined()

    const oversized = new File([new Uint8Array(33 * 1024)], "favicon.png", {
      type: "image/png",
    })
    fireEvent.change(screen.getByLabelText("Favicon"), {
      target: { files: [oversized] },
    })
    expect(
      screen.getByText("Favicon files must be at most 32 KB.")
    ).toBeDefined()

    expect(methodCalls(fetchMock, "POST")).toHaveLength(0)
    expect(screen.queryByText("Unsaved changes")).toBeNull()
  })

  it("labels persisted images as saved and previews favicons via the image route", () => {
    const faviconId = "44444444-4444-4444-8444-444444444444"
    const { container } = renderSettings({
      logoLightImageId: IMAGE_ID,
      faviconImageId: faviconId,
    })
    expect(screen.getByText("Current logo — saved")).toBeDefined()
    expect(screen.getByText("Current favicon — saved")).toBeDefined()
    const sources = Array.from(container.querySelectorAll("img")).map((img) =>
      img.getAttribute("src")
    )
    expect(sources).toContain(`/api/v1/images/${faviconId}`)
    // Nothing is pending on a fresh load.
    expect(screen.queryByText("Ready — save to apply")).toBeNull()
    expect(screen.queryByText("Unsaved changes")).toBeNull()
  })
})

describe("StatusPageSettings custom head", () => {
  it("describes accepted meta and icon link tags", () => {
    renderSettings()
    expect(screen.getByLabelText("Custom head")).toBeDefined()
    expect(
      screen.getByText(/Restricted fragment rendered on the public page/)
    ).toBeDefined()
    expect(screen.getByText(/icon <link>/i)).toBeDefined()
  })

  it("shows validation errors for unsafe fragments and blocks save", () => {
    const fetchMock = stubFetch()
    renderSettings()
    fireEvent.change(screen.getByLabelText("Custom head"), {
      target: { value: "<script>alert(1)</script>" },
    })
    expect(screen.getByRole("alert").textContent?.toLowerCase()).toContain(
      "script"
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(methodCalls(fetchMock, "PUT")).toHaveLength(0)
  })

  it("accepts safe OG meta without an alert", () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText("Custom head"), {
      target: {
        value: '<meta property="og:title" content="Acme Status">',
      },
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("uploadValidationError", () => {
  it("mirrors the server type allowlists and byte caps", () => {
    const png = (bytes: number) =>
      new File([new Uint8Array(bytes)], "a.png", { type: "image/png" })
    expect(uploadValidationError("logo-light", png(512 * 1024))).toBe("")
    expect(uploadValidationError("logo-light", png(512 * 1024 + 1))).toBe(
      "Images must be at most 512 KB."
    )
    expect(uploadValidationError("favicon", png(32 * 1024))).toBe("")
    expect(uploadValidationError("favicon", png(32 * 1024 + 1))).toBe(
      "Favicon files must be at most 32 KB."
    )
    expect(
      uploadValidationError(
        "logo-dark",
        new File(["x"], "a.gif", { type: "image/gif" })
      )
    ).toBe("Use a PNG, JPEG, SVG, or WebP image.")
    expect(
      uploadValidationError(
        "favicon",
        new File(["x"], "a.ico", { type: "image/vnd.microsoft.icon" })
      )
    ).toBe("")
    expect(
      uploadValidationError(
        "favicon",
        new File(["x"], "a.webp", { type: "image/webp" })
      )
    ).toBe("Use a PNG, ICO, or SVG file.")
  })
})

describe("document helpers", () => {
  it("compares and projects the full field list", () => {
    const document = baseConfig()
    expect(documentsEqual(document, baseConfig())).toBe(true)
    expect(documentsEqual(document, baseConfig({ uptimeDecimals: 3 }))).toBe(
      false
    )
    expect(Object.keys(toDocument(document)).sort()).toEqual(
      [...STATUS_PAGE_FIELDS].sort()
    )
  })
})
