import { cn } from "@media/ui/lib/utils";

import logo from "../../../../brand/lar-flat.svg";

/** The Lar logo where the account client shows the product: Flat, as the brand sets it at this size. */
export function LarMark({ className }: { readonly className?: string }) {
  return <img src={logo} alt="Lar" className={cn("size-8 shrink-0", className)} />;
}
