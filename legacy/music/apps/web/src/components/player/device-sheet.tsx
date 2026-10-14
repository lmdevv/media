import { usePlayer } from "@music/player/react";
import { Dialog, DialogContent } from "@music/ui/components/dialog";
import { Sheet, SheetContent } from "@music/ui/components/sheet";

import { useUi } from "@/components/shell/ui-state";
import { useIsDesktop } from "@/lib/use-media";

import { DeviceList } from "./devices";
import { shownSurface } from "./play-on";

/**
 * "Play on" for the app shell. While Now Playing is open it renders `PlayOnSurfaces` itself, inside
 * its dialog, so a tap in the sheet or dialog isn't a press outside Now Playing.
 */
export function DeviceSheet() {
  const { nowPlaying } = useUi();
  const player = usePlayer();

  return nowPlaying !== null && player.track !== null ? null : <PlayOnSurfaces />;
}

/**
 * "Play on" wherever the player bar's popover isn't: the phone sheet (Paper 07 · 04), and on
 * desktop a dialog when it was opened with nothing loaded or over Now Playing. Opened from the
 * command menu, the `d` key, or the phone Now Playing, so moving playback is always reachable.
 */
export function PlayOnSurfaces() {
  const { playOn, closePlayOn } = useUi();
  const desktop = useIsDesktop();
  const player = usePlayer();
  const track = player.track;
  const shown = shownSurface(playOn, desktop);
  const description = track === null ? undefined : `${track.title} · ${track.artist}`;

  const onOpenChange = (open: boolean) => {
    if (!open) closePlayOn();
  };

  return (
    <>
      <Sheet open={shown === "sheet"} onOpenChange={onOpenChange}>
        <SheetContent title="Play on" description={description}>
          <DeviceList touch />
        </SheetContent>
      </Sheet>
      <Dialog open={shown === "dialog"} onOpenChange={onOpenChange}>
        <DialogContent
          title="Play on"
          description="Open [music] in any browser while signed in and it shows up here."
        >
          <DeviceList />
        </DialogContent>
      </Dialog>
    </>
  );
}
