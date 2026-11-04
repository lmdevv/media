import { Button } from "@media/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@media/ui/components/dialog";
import { useRef } from "react";

/**
 * "Leave playback?", asked when Escape has nothing else to close. Stay is focused first, and Stay,
 * Escape, and a click outside all keep playing; only Leave leaves. A held Escape repeats, and its
 * repeats never close the dialog its first press opened.
 *
 * @param container - Where the dialog renders; the body when undefined.
 * @param returnFocus - Where focus goes when the dialog closes and playback continues, or false when
 *   the caller has moved it already.
 */
export function LeaveDialog({
  open,
  container,
  returnFocus,
  onStay,
  onLeave,
}: {
  readonly open: boolean;
  readonly container: HTMLElement | undefined;
  readonly returnFocus: () => HTMLElement | false;
  readonly onStay: () => void;
  readonly onLeave: () => void;
}) {
  const stay = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;

        if (details.reason === "escape-key" && details.event.repeat) {
          details.cancel();

          return;
        }

        onStay();
      }}
    >
      <DialogContent
        title="Leave playback?"
        size="sm"
        container={container}
        initialFocus={stay}
        finalFocus={returnFocus}
        className="on-media bg-dark-surface"
      >
        <DialogFooter className="border-t-0 pb-6">
          <DialogClose ref={stay} render={<Button variant="ghost" size="dialog" />}>
            Stay
          </DialogClose>
          <Button size="dialog" onClick={onLeave}>
            Leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
