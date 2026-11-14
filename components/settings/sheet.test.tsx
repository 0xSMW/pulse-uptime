// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SheetIconButton } from "./sheet"

afterEach(() => {
  cleanup()
})

describe("SheetIconButton", () => {
  it("shows the label in the tooltip when enabled", () => {
    const onClick = vi.fn()
    render(
      <SheetIconButton
        disabledDescription="A change is in progress"
        label="Close sheet"
        onClick={onClick}
      >
        x
      </SheetIconButton>
    )
    expect(screen.getByRole("tooltip").textContent).toBe("Close sheet")
    const button = screen.getByRole("button", { name: "Close sheet" })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("shows the disabled reason in a wrapping tooltip and ignores clicks", () => {
    const onClick = vi.fn()
    render(
      <SheetIconButton
        disabled
        disabledDescription="A change is in progress"
        label="Close sheet"
        onClick={onClick}
      >
        x
      </SheetIconButton>
    )
    const tooltip = screen.getByRole("tooltip")
    expect(tooltip.textContent).toBe("A change is in progress")
    expect(tooltip.className).toContain("whitespace-normal")
    expect(tooltip.className).not.toContain("whitespace-nowrap")
    expect(tooltip.className).toContain("max-w-[min(16rem,calc(100vw-3rem))]")

    const button = screen.getByRole("button", { name: "Close sheet" })
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id)
    const wrapper = button.parentElement!
    expect(wrapper.getAttribute("tabindex")).toBe("0")
    expect(wrapper.getAttribute("aria-label")).toBe(
      "Close sheet. A change is in progress"
    )

    fireEvent.click(button)
    fireEvent.click(wrapper)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("keeps the label when disabled without a reason", () => {
    render(
      <SheetIconButton disabled label="Close sheet" onClick={vi.fn()}>
        x
      </SheetIconButton>
    )
    expect(screen.getByRole("tooltip").textContent).toBe("Close sheet")
    const wrapper = screen.getByRole("button", {
      name: "Close sheet",
    }).parentElement!
    expect(wrapper.hasAttribute("aria-label")).toBe(false)
  })
})
