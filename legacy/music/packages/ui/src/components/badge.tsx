import { cn } from "@music/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center rounded-xs px-1.5 font-mono text-xs/xs tracking-mono whitespace-nowrap uppercase",
  {
    variants: {
      tone: {
        accent: "bg-accent py-0.75 text-on-accent",
        outline: "border border-border py-0.5 text-text-muted",
        surface: "bg-surface py-0.75 text-text-muted",
      },
    },
    defaultVariants: { tone: "outline" },
  },
);

/** The mono quality badge from Paper (`FLAC 24/96`, `AAC 256 · CELLULAR`) and status tags. */
export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
