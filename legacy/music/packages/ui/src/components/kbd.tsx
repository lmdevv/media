import { cn } from "@music/ui/lib/utils";
import type { ComponentProps } from "react";

/** A keyboard shortcut hint, such as `⌘K` or `ESC`, drawn as a small mono keycap. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex shrink-0 items-center rounded-[4px] border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] leading-[14px] text-text-muted",
        className,
      )}
      {...props}
    />
  );
}
