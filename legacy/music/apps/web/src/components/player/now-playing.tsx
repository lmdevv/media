import { usePlayer } from "@music/player/react";
import { Dialog, DialogPopup, DialogPortal } from "@music/ui/components/dialog";
import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import { useUi } from "@/components/shell/ui-state";

import { PlayOnSurfaces } from "./device-sheet";
import { DesktopNowPlaying } from "./now-playing-desktop";
import { PhoneNowPlaying } from "./now-playing-phone";

/**
 * Now Playing, always on the art-tinted dark background. Desktop has the player, queue, and
 * cover-only views (Paper 05 · 01, 01c, 01d); phones get the full-screen player and queue
 * (05 · 04, 04c). Lyrics are V1, so their button is shown but disabled.
 */
export function NowPlaying() {
  const { nowPlaying, setNowPlaying } = useUi();
  const player = usePlayer();
  const location = useLocation();

  useEffect(() => {
    setNowPlaying(null);
  }, [location.pathname, setNowPlaying]);

  const open = nowPlaying !== null && player.track !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : setNowPlaying(null))}>
      <DialogPortal>
        <DialogPopup
          aria-label="Now Playing"
          className="dark fixed inset-0 z-50 overflow-y-auto bg-dark-bg text-text outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-8 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-8"
        >
          {nowPlaying !== null && player.track !== null ? (
            <>
              <div className="hidden h-full lg:block">
                <DesktopNowPlaying track={player.track} view={nowPlaying} onView={setNowPlaying} />
              </div>
              <div className="h-full lg:hidden">
                <PhoneNowPlaying track={player.track} view={nowPlaying} onView={setNowPlaying} />
              </div>
              <PlayOnSurfaces />
            </>
          ) : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
