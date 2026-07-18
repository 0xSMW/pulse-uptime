import * as React from "react";

import { cn } from "@/lib/utils";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  htmlFor?: string;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
}

const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  (
    { children, className, description, error, htmlFor, label, required, ...props },
    ref,
  ) => (
    <div ref={ref} className={cn("grid gap-2", className)} {...props}>
      <label
        htmlFor={htmlFor}
        className="text-sm leading-5 font-medium text-[var(--fg)]"
      >
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs leading-4 text-[var(--down-text)]">
          {error}
        </p>
      ) : description ? (
        <p className="text-xs leading-4 text-[var(--fg-muted)]">{description}</p>
      ) : null}
    </div>
  ),
);
Field.displayName = "Field";

export { Field };
