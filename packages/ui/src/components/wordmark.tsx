import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

/** The `[movies]` wordmark in heavy Netflix red. */
export function Wordmark({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="wordmark"
      className={cn(
        "font-sans text-logo/7.5 font-heavy tracking-snug whitespace-nowrap text-accent select-none",
        className,
      )}
      {...props}
    >
      [movies]
    </span>
  );
}
