import { OTPField } from "@base-ui/react/otp-field";
import { cn } from "@media/ui/lib/utils";
import { Fragment, useId } from "react";

const toUpperCase = (value: string): string => value.toUpperCase();

/**
 * Large per-character boxes for a device code (`HD5R-5GTL`) or a profile PIN. It is one OTP field:
 * typing advances, Backspace goes back, and pasting fills every box.
 *
 * @param kind - `code` draws 56×72 letter boxes (36×52 on narrow phones) and accepts letters and digits (upper-cased);
 *   `pin` draws 72×84 boxes, accepts digits and masks them.
 * @param groupSize - Draws a dash after every this many boxes, such as 4 for `HD5R-5GTL`.
 * @param invalid - Marks every box with the danger color, after a wrong PIN.
 * @param autoFocus - Puts the cursor in the first box on mount, for a page that asks only for it.
 * @param stale - Dims the characters inside warning-tinted boxes, for a code that has expired.
 */
export function CodeInput({
  length,
  kind = "code",
  groupSize,
  value,
  onValueChange,
  onComplete,
  invalid = false,
  stale = false,
  autoFocus = false,
  label,
  className,
}: {
  readonly length: number;
  readonly kind?: "code" | "pin";
  readonly groupSize?: number;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onComplete?: ((value: string) => void) | undefined;
  readonly invalid?: boolean;
  readonly stale?: boolean;
  readonly autoFocus?: boolean;
  /** Accessible name of the whole field, such as `Code from your TV`. */
  readonly label: string;
  readonly className?: string;
}) {
  const pin = kind === "pin";
  const id = useId();

  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <OTPField.Root
        id={id}
        length={length}
        value={value}
        onValueChange={(next) => onValueChange(next)}
        onValueComplete={(next) => onComplete?.(next)}
        validationType={pin ? "numeric" : "alphanumeric"}
        normalizeValue={pin ? undefined : toUpperCase}
        mask={pin}
        aria-invalid={invalid || undefined}
        className={cn("flex items-center", pin ? "gap-4" : "gap-1.5 sm:gap-2", className)}
      >
        {Array.from({ length }, (_, index) => (
          <Fragment key={index}>
            {groupSize !== undefined && index > 0 && index % groupSize === 0 ? (
              <OTPField.Separator className="h-0.5 w-4 shrink-0 rounded-bar bg-text-muted" />
            ) : null}
            <OTPField.Input
              autoFocus={autoFocus && index === 0}
              aria-label={
                index === 0 ? undefined : `${pin ? "Digit" : "Character"} ${index + 1} of ${length}`
              }
              className={cn(
                "shrink-0 rounded-control border bg-surface-raised text-center font-mono font-medium text-text caret-accent outline-none focus:border-2 focus:border-accent",
                pin
                  ? "h-21 w-18 text-display/display"
                  : "h-13 w-9 text-heading/heading sm:h-18 sm:w-14 sm:text-title/10",
                invalid
                  ? "border-2 border-danger"
                  : stale
                    ? "border-warning/55 text-text-muted"
                    : "border-hairline",
              )}
            />
          </Fragment>
        ))}
      </OTPField.Root>
    </>
  );
}
