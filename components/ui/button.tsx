import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-transparent font-medium font-sans text-sm leading-5 transition-[background-color,border-color,color,opacity] duration-150 ease-[cubic-bezier(0.175,0.885,0.32,1.1)] disabled:cursor-not-allowed disabled:border-transparent disabled:bg-[var(--chip-bg)] disabled:text-[var(--fg-faint)] disabled:opacity-100",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--fg)] text-[var(--bg)] hover:opacity-90 active:opacity-80",
        secondary:
          "border-[var(--border-strong)] bg-[var(--bg)] text-[var(--fg)] hover:border-[var(--border-hover)] active:bg-[var(--hover)]",
        tertiary:
          "bg-transparent text-[var(--fg)] hover:bg-[var(--hover)] active:bg-[var(--chip-bg)]",
        error:
          "bg-[var(--error-solid)] text-white hover:brightness-110 active:brightness-95",
        "error-outline":
          "border-[var(--down-border)] bg-[var(--bg)] text-[var(--down-text)] hover:border-[var(--down-text)] active:bg-[var(--down-bg)]",
      },
      size: {
        sm: "h-8 px-1.5",
        md: "h-10 px-2.5",
        lg: "h-12 px-3.5 text-base",
        icon: "size-10 p-0",
        "icon-sm": "size-8 p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = ({
  className,
  type = "button",
  variant,
  size,
  ref,
  ...props
}: ButtonProps & { ref?: React.RefObject<HTMLButtonElement | null> }) => (
  <button
    className={cn(buttonVariants({ variant, size }), className)}
    ref={ref}
    type={type}
    {...props}
  />
)
Button.displayName = "Button"

export { Button, buttonVariants }
