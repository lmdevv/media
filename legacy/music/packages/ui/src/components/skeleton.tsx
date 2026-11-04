import { cn } from "@music/ui/lib/utils";
import type { ComponentProps } from "react";

/** A placeholder block drawn in the surface color while content loads. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-2xs bg-surface", className)}
      {...props}
    />
  );
}
