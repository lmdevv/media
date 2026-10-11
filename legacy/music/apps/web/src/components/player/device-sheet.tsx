import { usePlayer } from "@music/player/react";
import { Sheet, SheetContent } from "@music/ui/components/sheet";

import { useUi } from "@/components/shell/ui-state";
import { useIsDesktop } from "@/lib/use-media";

import { DeviceList } from "./devices";

/** The phone "Play on" sheet (Paper 07 · 04), opened from the command menu or the `d` key. */
export function DeviceSheet() {
  const { devicesOpen, setDevicesOpen } = useUi();
  const desktop = useIsDesktop();
  const player = usePlayer();
  const track = player.track;

  return (
    <Sheet open={devicesOpen && !desktop} onOpenChange={setDevicesOpen}>
      <SheetContent
        title="Play on"
        description={track === null ? undefined : `${track.title} · ${track.artist}`}
      >
        <DeviceList touch />
      </SheetContent>
    </Sheet>
  );
}
