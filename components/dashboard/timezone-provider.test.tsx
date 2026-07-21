// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  LEGACY_TIMEZONE_STORAGE_KEY,
  TIMEZONE_STORAGE_KEY,
  TimezoneProvider,
  useTimezone,
} from "./timezone-provider"

function StaticProbe() {
  const { timezone, resolvedTimeZone } = useTimezone()
  return <span>{`${timezone}|${resolvedTimeZone}`}</span>
}

let captured: ReturnType<typeof useTimezone> | null = null

function ContextProbe({
  onValue,
}: {
  onValue: (value: ReturnType<typeof useTimezone>) => void
}) {
  const value = useTimezone()
  React.useEffect(() => {
    onValue(value)
  })
  return null
}

async function mountProvider() {
  render(
    <TimezoneProvider>
      <ContextProbe
        onValue={(value) => {
          captured = value
        }}
      />
    </TimezoneProvider>
  )
  // Flush the storage-loading effect and its queued microtask.
  await act(async () => {
    // flush effects only
  })
}

afterEach(() => {
  cleanup()
  captured = null
  window.localStorage.clear()
})

describe("TimezoneProvider", () => {
  it("defaults to the device time zone, rendering UTC on the server", () => {
    expect(DEFAULT_TIMEZONE).toBe("system")
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <StaticProbe />
      </TimezoneProvider>
    )
    expect(html).toContain("system|UTC")
  })

  it("honors an explicit default", () => {
    const html = renderToStaticMarkup(
      <TimezoneProvider defaultTimezone="Asia/Bangkok">
        <StaticProbe />
      </TimezoneProvider>
    )
    expect(html).toContain("Asia/Bangkok|Asia/Bangkok")
  })

  it("validates IANA zone names", () => {
    expect(isValidTimeZone("Asia/Bangkok")).toBe(true)
    expect(isValidTimeZone("system")).toBe(true)
    expect(isValidTimeZone("Not/AZone")).toBe(false)
  })
})

describe("single-writer time zone model", () => {
  it("prefers a device override over the adopted server value", async () => {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "Asia/Tokyo")
    await mountProvider()
    act(() => captured!.adoptServerTimezone("Asia/Bangkok"))
    expect(captured!.deviceOverride).toBe("Asia/Tokyo")
    expect(captured!.serverTimezone).toBe("Asia/Bangkok")
    expect(captured!.timezone).toBe("Asia/Tokyo")
  })

  it("falls back to the server value, then system, when no override exists", async () => {
    await mountProvider()
    expect(captured!.timezone).toBe("system")
    act(() => captured!.adoptServerTimezone("Asia/Bangkok"))
    expect(captured!.timezone).toBe("Asia/Bangkok")
    act(() => captured!.adoptServerTimezone(null))
    expect(captured!.timezone).toBe("system")
  })

  it("committing the account value clears the device override key", async () => {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "Asia/Tokyo")
    await mountProvider()
    act(() => captured!.setServerTimezone("Asia/Bangkok"))
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBeNull()
    expect(captured!.deviceOverride).toBeNull()
    expect(captured!.timezone).toBe("Asia/Bangkok")
  })

  it("adopting the server value never touches the device key", async () => {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "Asia/Tokyo")
    await mountProvider()
    act(() => captured!.adoptServerTimezone("Asia/Bangkok"))
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBe("Asia/Tokyo")
  })

  it("creates and resets an explicit device override", async () => {
    await mountProvider()
    act(() => captured!.setDeviceOverride("UTC"))
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBe("UTC")
    expect(captured!.timezone).toBe("UTC")
    act(() => captured!.setDeviceOverride(null))
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBeNull()
    expect(captured!.deviceOverride).toBeNull()
  })

  it("drops a legacy stored 'system' value instead of treating it as an override", async () => {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "system")
    await mountProvider()
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBeNull()
    expect(captured!.deviceOverride).toBeNull()
    expect(captured!.timezone).toBe("system")
  })

  it("stores deliberate overrides on a key distinct from the legacy one", () => {
    expect(TIMEZONE_STORAGE_KEY).toBe("pulse-timezone-override")
    expect(LEGACY_TIMEZONE_STORAGE_KEY).toBe("pulse-timezone")
    expect(TIMEZONE_STORAGE_KEY).not.toBe(LEGACY_TIMEZONE_STORAGE_KEY)
  })

  it("never promotes a legacy concrete zone to a device override and deletes the key", async () => {
    window.localStorage.setItem(LEGACY_TIMEZONE_STORAGE_KEY, "Asia/Tokyo")
    await mountProvider()
    expect(window.localStorage.getItem(LEGACY_TIMEZONE_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBeNull()
    expect(captured!.deviceOverride).toBeNull()
    // The account value still wins once it arrives.
    act(() => captured!.adoptServerTimezone("Asia/Bangkok"))
    expect(captured!.timezone).toBe("Asia/Bangkok")
  })

  it("round-trips a deliberate override on the new key only", async () => {
    await mountProvider()
    act(() => captured!.setDeviceOverride("Asia/Tokyo"))
    expect(window.localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBe("Asia/Tokyo")
    expect(window.localStorage.getItem(LEGACY_TIMEZONE_STORAGE_KEY)).toBeNull()
    cleanup()
    captured = null
    await mountProvider()
    expect(captured!.deviceOverride).toBe("Asia/Tokyo")
    expect(captured!.timezone).toBe("Asia/Tokyo")
  })
})
