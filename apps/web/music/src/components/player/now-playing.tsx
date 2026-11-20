import { lyricsAnswer } from "@media/player/lyrics";
import { usePlayer } from "@media/player/react";
import { keepsShortcutsProps } from "@media/ui/lib/focus-policy";
import { Dialog, DialogPopup, DialogPortal } from "@/components/ui/dialog";

import { useUi } from "@/components/shell/ui-state";
import { useMusic, useQueryState } from "@/lib/platform";
import { useIsDesktop } from "@/lib/use-media";

import { PlayOnSurfaces } from "./device-sheet";
import { DesktopNowPlaying } from "./now-playing-desktop";
import { PhoneNowPlaying } from "./now-playing-phone";

/**
 * Now Playing, always on the art-tinted dark background. Desktop opens on the cover and can add the
 * queue or the lyrics beside it; phones get the full-screen player, queue, and lyrics.
 */
export function NowPlaying() {
  const { nowPlaying, setNowPlaying } = useUi();
  const player = usePlayer();
  const desktop = useIsDesktop();
  const trackId = nowPlaying === null ? null : (player.track?.id ?? null);

  const lyrics = lyricsAnswer(
    useQueryState(useMusic().lyrics.get, trackId === null ? "skip" : { trackId }),
  );

  const open = nowPlaying !== null && player.track !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : setNowPlaying(null))}>
      <DialogPortal>
        <DialogPopup
          {...keepsShortcutsProps}
          aria-label="Now Playing"
          className="dark fixed inset-0 z-50 overflow-y-auto bg-dark-bg text-text outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-8 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-8"
        >
          {nowPlaying !== null && player.track !== null ? (
            <>
              <div className="h-full">
                {desktop ? (
                  <DesktopNowPlaying
                    track={player.track}
                    lyrics={lyrics}
                    view={nowPlaying}
                    onView={setNowPlaying}
                  />
                ) : (
                  <PhoneNowPlaying
                    track={player.track}
                    lyrics={lyrics}
                    view={nowPlaying}
                    onView={setNowPlaying}
                  />
                )}
              </div>
              <PlayOnSurfaces />
            </>
          ) : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
