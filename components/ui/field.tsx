import * as React from "react"

import { cn } from "@/lib/utils"

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode
  htmlFor?: string
  description?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
}

const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  (
    {
      children,
      className,
      description,
      error,
      htmlFor,
      label,
      required,
      ...props
    },
    ref
  ) => (
    <div className={cn("grid gap-2", className)} ref={ref} {...props}>
      <label
        className="font-medium text-[var(--fg)] text-sm leading-5"
        htmlFor={htmlFor}
      >
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-[var(--down-text)] text-xs leading-4" role="alert">
          {error}
        </p>
      ) : description ? (
        <p className="text-[var(--fg-muted)] text-xs leading-4">
          {description}
        </p>
      ) : null}
    </div>
  )
)
Field.displayName = "Field"

export { Field }
