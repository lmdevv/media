import { cn } from "@/lib/utils";
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

/**
 * A skeleton bar on one line of the text set in `className`, so it takes that line's height.
 *
 * @param bar - The bar's own size, such as `h-3 w-48`.
 */
export function SkeletonLine({
  className,
  bar,
}: {
  readonly className: string;
  readonly bar: string;
}) {
  return (
    <span aria-hidden className={cn("flex items-center", className)}>
      <Skeleton className={bar} />
      {"​"}
    </span>
  );
}
