import { cn } from "@media/ui/lib/utils";
import { CircleAlertIcon } from "lucide-react";
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { Input } from "./input";

/**
 * A short error under a field or form, in the danger color with an alert icon. Errors never use a
 * colored stripe.
 */
export function FieldError({
  children,
  id,
  className,
}: {
  readonly children: ReactNode;
  readonly id?: string;
  readonly className?: string;
}) {
  return (
    <p
      id={id}
      className={cn(
        "flex items-start gap-2 pt-1 font-sans text-label/label text-danger",
        className,
      )}
    >
      <CircleAlertIcon className="mt-px size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="flex-1">{children}</span>
    </p>
  );
}

/**
 * A labeled text input with an optional inline error line.
 *
 * @param labelAction - Sits at the right end of the label row, such as a "Forgot?" link.
 * @param trailing - Sits inside the input at its right end, such as a show-password button.
 * @param error - Short error text; marks the input invalid and describes it.
 */
export function TextField({
  label,
  labelAction,
  trailing,
  error,
  id,
  className,
  ...props
}: Omit<ComponentProps<"input">, "children"> & {
  readonly label: string;
  readonly labelAction?: ReactNode;
  readonly trailing?: ReactNode;
  readonly error?: string | undefined;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;
  const invalid = error !== undefined;

  return (
    <div data-slot="text-field" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="font-sans text-label/4 font-medium text-text-muted">
          {label}
        </label>
        {labelAction}
      </div>
      <div className="relative flex items-center">
        <Input
          id={inputId}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          className={trailing === undefined ? undefined : "pr-11"}
          {...props}
        />
        {trailing === undefined ? null : (
          <span className="absolute right-3.5 flex items-center text-text-muted">{trailing}</span>
        )}
      </div>
      {invalid ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
