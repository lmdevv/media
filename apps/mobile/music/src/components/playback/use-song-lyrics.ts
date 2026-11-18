import type { TrackId } from "@/lib/models";
import { lyricsAnswer, lyricsOffer } from "@media/player/lyrics";
import type { LyricsAnswer, LyricsOffer, TrackLyrics } from "@media/player/lyrics";
import { usePlatform } from "@media/sdk/react";
import { useState } from "react";

import { useDownloadedLyrics } from "@/downloads";
import { useQueryState } from "@/lib/platform";
import { defaultPanel } from "@/lib/now-playing-layout";
import type { Panel } from "@/lib/now-playing-layout";
import { useOwnSession } from "@/player";
import { useServerReach } from "@/session/server-reach";

/**
 * The lyrics to show while the server can't be counted on (it is out of reach, or this phone
 * plays its own queue): those the phone keeps with its download (`loading` while it reads them),
 * else the server's last answer as a phone without the server shows it, else none. A lookup still
 * pending never finishes without the server, so it shows the song's own plain words it carries,
 * or nothing, rather than loading for good.
 */
const offlineLyrics = (
  served: LyricsAnswer,
  held: ReturnType<typeof useDownloadedLyrics>,
): LyricsAnswer => {
  if (held !== null) return held;

  if (served === "loading" || served === "failed") return NONE;

  if (served.status !== "pending") return served;

  return served.fallback === null
    ? NONE
    : { status: "plain", source: "file", main: served.fallback, extras: [] };
};

const NONE: TrackLyrics = { status: "none" };

/** A song's lyrics, what they offer, and the panel they make the default. */
export interface SongLyrics {
  readonly lyrics: LyricsAnswer;
  readonly offer: LyricsOffer;
  /** `defaultPanel` for the last settled answer, kept while the next song's lookup runs. */
  readonly fallback: Panel | null;
}

/**
 * Reads the lyrics of `trackId`; null reads nothing. Settled, not thrown: a failed read shows in
 * the lyrics instead of taking the screen down.
 */
export const useSongLyrics = (trackId: TrackId | null): SongLyrics => {
  const ownSession = useOwnSession();
  const platform = usePlatform();

  const served = lyricsAnswer(
    useQueryState(platform.music.lyrics.get, trackId === null ? "skip" : { trackId }),
  );

  const reach = useServerReach();
  const offline = ownSession || reach !== "online";
  const held = useDownloadedLyrics(offline ? trackId : null);
  const lyrics = offline ? offlineLyrics(served, held) : served;
  const offer = lyricsOffer(lyrics);

  const [settled, setSettled] = useState<Panel | null>(null);
  const fallback = defaultPanel(offer, settled);

  if (fallback !== settled) setSettled(fallback);

  return { lyrics, offer, fallback };
};
