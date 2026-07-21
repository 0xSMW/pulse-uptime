"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  anchor,
  ...props
}: TooltipPrimitive.Popup.Props & {
  side?: TooltipPrimitive.Positioner.Props["side"]
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"]
  align?: TooltipPrimitive.Positioner.Props["align"]
  anchor?: TooltipPrimitive.Positioner.Props["anchor"]
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="z-[90] outline-none"
        collisionPadding={12}
        side={side}
        sideOffset={sideOffset}
      >
        {/* pointer-events-none so the popup never intercepts the hover that
            reveals it, which would otherwise flicker at the popup edge. */}
        <TooltipPrimitive.Popup
          className={cn(
            "pointer-events-none max-w-[260px] rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 font-medium text-[var(--fg)] text-xs shadow-[var(--popover-shadow)] outline-none",
            "transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
            className
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
