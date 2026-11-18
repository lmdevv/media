import { cn } from "@/lib/utils";

import icon from "../../../../../../brand/lar-music.svg";

/** The Lar Music app icon, where the client shows the app. */
export function MusicMark({ className }: { readonly className?: string }) {
  return <img src={icon} alt="Lar Music" className={cn("size-8 shrink-0", className)} />;
}
