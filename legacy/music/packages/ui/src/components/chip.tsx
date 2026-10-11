import { cn } from "@music/ui/lib/utils";
import type { ComponentProps } from "react";

/**
 * A filter or choice pill (Albums filters, "Who can see it", "Start with"). Selected chips are
 * the dark neutral pill; others sit on the surface. `aria-pressed` carries the state.
 */
export function Chip({
  className,
  selected,
  size = "md",
  ...props
}: ComponentProps<"button"> & { readonly selected: boolean; readonly size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex shrink-0 cursor-pointer items-center rounded-full font-sans text-sm/xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)",
        size === "sm" ? "h-8 px-3" : "h-9 px-3.5",
        selected ? "bg-text text-text-inverse" : "bg-surface text-text hover:bg-border",
        className,
      )}
      {...props}
    />
  );
}
