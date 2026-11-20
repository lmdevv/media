import { Button } from "@media/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@media/ui/components/dialog";
import { useRef } from "react";

/**
 * "Are you still watching?", asked over the paused player in place of autoplay's next episode.
 * Continue watching is focused first. Escape, a click outside, and the close button keep watching
 * too, since someone is there to press them; only I'm done leaves.
 *
 * @param container - Where the dialog renders; the body when undefined.
 */
export function StillWatchingDialog({
  open,
  container,
  onContinue,
  onDone,
}: {
  readonly open: boolean;
  readonly container: HTMLElement | undefined;
  readonly onContinue: () => void;
  readonly onDone: () => void;
}) {
  const keepWatching = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onContinue();
      }}
    >
      <DialogContent
        title="Are you still watching?"
        size="sm"
        container={container}
        initialFocus={keepWatching}
        className="on-media bg-dark-surface"
      >
        <DialogFooter className="border-t-0 pb-6">
          <Button variant="ghost" size="dialog" onClick={onDone}>
            I'm done
          </Button>
          <Button ref={keepWatching} size="dialog" onClick={onContinue}>
            Continue watching
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
