import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

/** One key of a shortcut, drawn as a small mono keycap: `G`, `⌘`, `↵`. */
export function Keycap({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="keycap"
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-poster bg-text/6 px-1.25 font-mono text-micro/3.5 text-text-muted",
        className,
      )}
      {...props}
    />
  );
}

/** A shortcut as a row of keycaps, such as `G H` or `⌘ ⇧ P`. Renders nothing for no keys. */
export function Keycaps({
  keys,
  className,
}: {
  readonly keys: ReadonlyArray<string>;
  readonly className?: string;
}) {
  if (keys.length === 0) return null;

  return (
    <kbd data-slot="keycaps" className={cn("flex shrink-0 gap-1", className)}>
      {keys.map((key, index) => (
        <Keycap key={`${index}-${key}`}>{key}</Keycap>
      ))}
    </kbd>
  );
}
