import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

/**
 * The Paper text input: 44px, raised fill, hairline border. `aria-invalid` turns the border to the
 * danger color. Use {@link TextField} for a labeled field with an error line.
 */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-control border border-hairline bg-surface-raised px-3.5 font-sans text-body/4.5 text-text caret-accent transition-colors placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled) aria-invalid:border-control aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}
