"use client"

import { createContext, useContext } from "react"

// Native dialogs opened with showModal() live in the browser top layer and
// make the rest of the document inert. Popover content portaled to
// document.body therefore paints beneath the dialog and cannot be clicked.
// Overlay hosts (sheets, dialogs) provide their own element here so popovers
// portal inside the top layer instead.
export const PortalContainerContext = createContext<HTMLElement | null>(null)

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined
}
