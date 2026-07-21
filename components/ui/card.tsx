import type * as React from "react"

import { cn } from "@/lib/utils"

const Card = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.RefObject<HTMLDivElement | null>
}) => (
  <div
    className={cn(
      "rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg)] shadow-[var(--card-shadow)]",
      className
    )}
    ref={ref}
    {...props}
  />
)
Card.displayName = "Card"

const CardHeader = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.RefObject<HTMLDivElement | null>
}) => (
  <div
    className={cn("flex flex-col gap-2 p-6 pb-0", className)}
    ref={ref}
    {...props}
  />
)
CardHeader.displayName = "CardHeader"

const CardTitle = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & {
  ref?: React.RefObject<HTMLHeadingElement | null>
}) => (
  <h2
    className={cn(
      "font-semibold text-[var(--fg)] text-sm leading-5 tracking-[-0.28px]",
      className
    )}
    ref={ref}
    {...props}
  />
)
CardTitle.displayName = "CardTitle"

const CardDescription = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement> & {
  ref?: React.RefObject<HTMLParagraphElement | null>
}) => (
  <p
    className={cn("text-[var(--fg-muted)] text-sm leading-5", className)}
    ref={ref}
    {...props}
  />
)
CardDescription.displayName = "CardDescription"

const CardContent = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.RefObject<HTMLDivElement | null>
}) => <div className={cn("p-6", className)} ref={ref} {...props} />
CardContent.displayName = "CardContent"

export { Card, CardContent, CardDescription, CardHeader, CardTitle }
