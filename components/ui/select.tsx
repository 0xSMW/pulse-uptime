"use client"

import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import * as React from "react"

import { usePortalContainer } from "@/components/ui/portal-container"
import { cn } from "@/lib/utils"

const Select = SelectPrimitive.Root
const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    className={cn(
      "flex h-10 w-full items-center justify-between rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-sm outline-none hover:border-[var(--border-hover)] focus-visible:border-[var(--focus)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-[var(--fg-muted)]",
      className
    )}
    ref={ref}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown
        aria-hidden
        className="size-4 shrink-0 text-[var(--fg-muted)]"
      />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => {
  // Portal into the nearest overlay host. A select inside a top-layer
  // dialog must render within that dialog or its menu is inert.
  const container = usePortalContainer()
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        className={cn(
          "relative z-[80] max-h-72 min-w-[8rem] overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--fg)] shadow-[var(--popover-shadow)] data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none",
          position === "popper" &&
            "data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        ref={ref}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-7 cursor-default items-center justify-center">
          <ChevronUp aria-hidden className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] min-w-[var(--radix-select-trigger-width)]"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-7 cursor-default items-center justify-center">
          <ChevronDown aria-hidden className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    className={cn(
      "relative flex h-9 w-full cursor-default select-none items-center rounded-[6px] py-2 pr-8 pl-8 text-[13px] outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-[var(--hover)] data-[highlighted]:text-[var(--fg)] data-[disabled]:opacity-50",
      className
    )}
    ref={ref}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
