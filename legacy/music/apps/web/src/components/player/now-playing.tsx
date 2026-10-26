import { usePlayer } from "@music/player/react";
import { useReadSettled } from "@music/sdk/react";
import { Dialog, DialogPopup, DialogPortal } from "@music/ui/components/dialog";

import { useUi } from "@/components/shell/ui-state";
import { useIsDesktop } from "@/lib/use-media";

import { PlayOnSurfaces } from "./device-sheet";
import { lyricsAnswer } from "./lyrics";
import { DesktopNowPlaying } from "./now-playing-desktop";
import { PhoneNowPlaying } from "./now-playing-phone";

/**
 * Now Playing, always on the art-tinted dark background. Desktop opens on the cover and can add the
 * queue or the lyrics beside it (Paper 05 · 01, 01c, 01b); phones get the full-screen player,
 * queue, and lyrics (05 · 04, 04c, 04b).
 */
export function NowPlaying() {
  const { nowPlaying, setNowPlaying } = useUi();
  const player = usePlayer();
  const desktop = useIsDesktop();
  const trackId = nowPlaying === null ? null : (player.track?.id ?? null);

  // While open, for the lyrics button's state as much as for the lyrics view. Settled, not
  // thrown: a failed read shows in the lyrics view instead of taking Now Playing down.
  const lyrics = lyricsAnswer(
    useReadSettled("lyrics.get", trackId === null ? "skip" : { trackId }),
  );

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
