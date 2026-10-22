/** A playlist sheet's G10: the playlist went away, or access ended, while the sheet was open. */
import { SheetLayout } from "@/components/ui/sheet-layout";
import type { Unavailable } from "@/lib/detail-state";

/** The sheet in place of one whose playlist the viewer can no longer open. */
export function SheetUnavailable({ state }: { readonly state: Unavailable }) {
  return (
    <SheetLayout
      title="Unavailable"
      subtitle={
        state.kind === "unavailable"
          ? "This playlist was removed, or you no longer have access to it."
          : state.message
      }
    />
  );
}
