import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-[var(--fg)] text-sm leading-5 transition-[border-color] duration-150 ease-[cubic-bezier(0.175,0.885,0.32,1.1)] hover:border-[var(--border-hover)] disabled:cursor-not-allowed disabled:bg-[var(--chip-bg)] disabled:text-[var(--fg-faint)] aria-invalid:border-[var(--down-text)]",
  {
    variants: {
      inputSize: {
        sm: "h-8",
        md: "h-10",
        lg: "h-12 text-base",
      },
    },
    defaultVariants: { inputSize: "md" },
  }
)

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = ({
  className,
  inputSize,
  ref,
  ...props
}: InputProps & { ref?: React.RefObject<HTMLInputElement | null> }) => (
  <input
    className={cn(inputVariants({ inputSize }), className)}
    ref={ref}
    {...props}
  />
)
Input.displayName = "Input"

export { Input, inputVariants }
