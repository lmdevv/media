import { cn } from "@media/ui/lib/utils";

import icon from "../../../../../brand/lar-movies.svg";

/** The Lar Movies app icon, where the client shows the app. */
export function MoviesMark({ className }: { readonly className?: string }) {
  return <img src={icon} alt="Lar Movies" className={cn("size-8 shrink-0", className)} />;
}
