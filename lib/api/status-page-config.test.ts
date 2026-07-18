import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

import type { StatusPageConfigDocument } from "@/lib/status-page/schema";

import {
  getStatusPageConfig,
  putStatusPageConfig,
  statusPageConfigEtag,
  StatusPageConfigError,
  type StatusPageConfigStore,
} from "./status-page-config";

const LOGO_LIGHT_ID = "11111111-1111-4111-8111-111111111111";
const LOGO_DARK_ID = "22222222-2222-4222-8222-222222222222";
const FAVICON_ID = "33333333-3333-4333-8333-333333333333";

const UPDATED_AT = new Date("2026-07-18T00:00:00.000Z");

function document(overrides: Partial<StatusPageConfigDocument> = {}): StatusPageConfigDocument {
  return {
    name: "Acme Status",
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
  };
}

function fakeStore(overrides: Partial<StatusPageConfigStore> = {}): StatusPageConfigStore {
  return {
    read: vi.fn().mockResolvedValue({ ...document(), updatedAt: UPDATED_AT }),
    write: vi.fn().mockResolvedValue(true),
    findImageKinds: vi.fn().mockResolvedValue([]),
    deleteUnreferencedImages: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe("statusPageConfigEtag", () => {
  it("derives a quoted millisecond timestamp with a zero seed marker", () => {
    expect(statusPageConfigEtag(null)).toBe('"0"');
    expect(statusPageConfigEtag(UPDATED_AT)).toBe(`"${UPDATED_AT.getTime()}"`);
  });
});

describe("getStatusPageConfig", () => {
  it("returns the stored document with its ETag", async () => {
    const store = fakeStore();
    const result = await getStatusPageConfig({ store, env: {} });
    expect(result.etag).toBe(`"${UPDATED_AT.getTime()}"`);
    expect(result.data.name).toBe("Acme Status");
    expect(result.data.updatedAt).toBe(UPDATED_AT.toISOString());
  });

  it("coalesces a NULL seeded name to the env var, then the runtime literal", async () => {
    const seeded = fakeStore({ read: vi.fn().mockResolvedValue({ ...document(), name: null, updatedAt: null }) });
    const withEnv = await getStatusPageConfig({ store: seeded, env: { NEXT_PUBLIC_STATUS_PAGE_NAME: "  Env Status  " } });
    expect(withEnv.data.name).toBe("Env Status");
    expect(withEnv.data.updatedAt).toBeNull();
    expect(withEnv.etag).toBe('"0"');

    const withoutEnv = await getStatusPageConfig({ store: seeded, env: {} });
    expect(withoutEnv.data.name).toBe("System Status");
  });

  it("never persists the coalesced name", async () => {
    const store = fakeStore({ read: vi.fn().mockResolvedValue({ ...document(), name: null, updatedAt: null }) });
    await getStatusPageConfig({ store, env: { NEXT_PUBLIC_STATUS_PAGE_NAME: "Env Status" } });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("fails loudly when the seeded row is missing", async () => {
    const store = fakeStore({ read: vi.fn().mockResolvedValue(null) });
    await expect(getStatusPageConfig({ store })).rejects.toMatchObject({ code: "CONFIG_UNAVAILABLE" });
  });
});

describe("putStatusPageConfig", () => {
  const etag = `"${UPDATED_AT.getTime()}"`;

  it("validates the document before touching the store", async () => {
    const store = fakeStore();
    await expect(putStatusPageConfig(document({ historyDays: 45 as never }), etag, { store }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("rejects a stale ETag with PRECONDITION_FAILED without writing", async () => {
    const store = fakeStore();
    await expect(putStatusPageConfig(document(), '"12345"', { store }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("treats a conditional-write miss as a concurrent conflict", async () => {
    const store = fakeStore({ write: vi.fn().mockResolvedValue(false) });
    await expect(putStatusPageConfig(document(), etag, { store }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects image references that are missing or of the wrong kind", async () => {
    const missing = fakeStore();
    await expect(putStatusPageConfig(document({ logoLightImageId: LOGO_LIGHT_ID }), etag, { store: missing }))
      .rejects.toMatchObject({ code: "IMAGE_REFERENCE_INVALID", details: { field: "logoLightImageId" } });
    expect(missing.write).not.toHaveBeenCalled();

    const wrongKind = fakeStore({
      findImageKinds: vi.fn().mockResolvedValue([{ id: FAVICON_ID, kind: "avatar" }]),
    });
    await expect(putStatusPageConfig(document({ faviconImageId: FAVICON_ID }), etag, { store: wrongKind }))
      .rejects.toMatchObject({ code: "IMAGE_REFERENCE_INVALID", details: { field: "faviconImageId" } });
  });

  it("writes conditionally on the previous updatedAt and returns the new ETag", async () => {
    const store = fakeStore({
      findImageKinds: vi.fn().mockResolvedValue([{ id: LOGO_LIGHT_ID, kind: "logo-light" }]),
    });
    const now = new Date("2026-07-18T09:30:00.000Z");
    const next = document({ name: "Renamed", logoLightImageId: LOGO_LIGHT_ID });
    const result = await putStatusPageConfig(
      { ...next, updatedAt: "2026-01-01T00:00:00.000Z" },
      etag,
      { store, now: () => now, env: {} },
    );
    expect(store.write).toHaveBeenCalledWith({ document: next, expectedUpdatedAt: UPDATED_AT, now });
    expect(result.etag).toBe(`"${now.getTime()}"`);
    expect(result.data.name).toBe("Renamed");
    expect(result.data.updatedAt).toBe(now.toISOString());
  });

  it("garbage-collects image rows the new document no longer references", async () => {
    const store = fakeStore({
      read: vi.fn().mockResolvedValue({
        ...document({ logoLightImageId: LOGO_LIGHT_ID, logoDarkImageId: LOGO_DARK_ID, faviconImageId: FAVICON_ID }),
        updatedAt: UPDATED_AT,
      }),
      findImageKinds: vi.fn().mockResolvedValue([{ id: LOGO_DARK_ID, kind: "logo-dark" }]),
    });
    await putStatusPageConfig(document({ logoDarkImageId: LOGO_DARK_ID }), etag, { store });
    expect(store.deleteUnreferencedImages).toHaveBeenCalledWith([LOGO_LIGHT_ID, FAVICON_ID]);
  });

  it("skips GC when references are unchanged and survives GC failures", async () => {
    const unchanged = fakeStore({
      read: vi.fn().mockResolvedValue({ ...document({ logoLightImageId: LOGO_LIGHT_ID }), updatedAt: UPDATED_AT }),
      findImageKinds: vi.fn().mockResolvedValue([{ id: LOGO_LIGHT_ID, kind: "logo-light" }]),
    });
    await putStatusPageConfig(document({ logoLightImageId: LOGO_LIGHT_ID }), etag, { store: unchanged });
    expect(unchanged.deleteUnreferencedImages).not.toHaveBeenCalled();

    const failing = fakeStore({
      read: vi.fn().mockResolvedValue({ ...document({ logoLightImageId: LOGO_LIGHT_ID }), updatedAt: UPDATED_AT }),
      deleteUnreferencedImages: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(putStatusPageConfig(document(), etag, { store: failing })).resolves.toBeDefined();
  });

  it("surfaces validation issues with paths in the error details", async () => {
    const store = fakeStore();
    const error = await putStatusPageConfig(document({ name: "" }), etag, { store }).catch((caught) => caught);
    expect(error).toBeInstanceOf(StatusPageConfigError);
    expect((error as StatusPageConfigError).details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "name" })]),
    );
  });
});
