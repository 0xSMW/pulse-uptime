import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const inputVariants = cva(
  "w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-sm leading-5 text-[var(--fg)] transition-[border-color] duration-150 ease-[cubic-bezier(0.175,0.885,0.32,1.1)] hover:border-[var(--border-hover)] disabled:cursor-not-allowed disabled:bg-[var(--chip-bg)] disabled:text-[var(--fg-faint)] aria-invalid:border-[var(--down-text)]",
  {
    variants: {
      inputSize: {
        sm: "h-8",
        md: "h-10",
        lg: "h-12 text-base",
      },
    },
    defaultVariants: { inputSize: "md" },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, inputSize, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(inputVariants({ inputSize }), className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input, inputVariants };
