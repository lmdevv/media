/** The playing song's lyrics, for Now Playing and the iPad's panel. */
import type { TrackId } from "@music/commands/ids";
import { lyricsAnswer, lyricsOffer, offlineLyrics } from "@music/player/lyrics";
import type { LyricsAnswer, LyricsOffer } from "@music/player/lyrics";
import { useReadSettled } from "@music/sdk/react";
import { useState } from "react";

import { useDownloadedLyrics } from "@/downloads";
import { defaultPanel } from "@/lib/now-playing-layout";
import type { Panel } from "@/lib/now-playing-layout";
import { useOwnSession } from "@/player";
import { useServerReach } from "@/session/server-reach";

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

  const served = lyricsAnswer(
    useReadSettled("lyrics.get", trackId === null ? "skip" : { trackId }),
  );

  // Kept lyrics are read from the vault only while the server can't be counted on.
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
