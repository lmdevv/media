import { cn } from "@media/ui/lib/utils";

import bone from "../../../../../brand/lar.svg";
import ink from "../../../../../brand/lar-flat-ink.svg";

export function LarMark({ className }: { readonly className?: string }) {
  return (
    <picture className="contents">
      <source srcSet={bone} media="(prefers-color-scheme: dark)" />
      <img src={ink} alt="Lar" className={cn("size-8 shrink-0", className)} />
    </picture>
  );
}

export function LarWordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <LarMark className="size-7.5" />
      <span className="font-display text-logo/6 font-heavy tracking-snug text-text font-stretch-112%">
        Lar
      </span>
    </span>
  );
}
