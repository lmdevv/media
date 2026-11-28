import { canLookUp, lookupKeyOf } from "@media/contracts/lyrics-lookup";

import type { Doc } from "../_generated/dataModel";
import { sha256Hex } from "../core/lib/secrets";

/**
 * A revision of the lyrics `music.lyrics.get` answers for `track`, read from the track alone: it
 * changes when the song's own lyrics change (`lyricsHash`), when an LRCLIB answer is stored
 * (`lrclibAt`), and when a retag makes another LRCLIB lookup key. It leaves out whether a lookup
 * is waiting, so a device asks again about lyrics it got while one was.
 */
export const lyricsRevisionOf = (track: Doc<"tracks">): Promise<string> => {
  const tags = {
    artist: track.artistName,
    title: track.title,
    album: track.albumTitle,
    durationMs: track.durationMs,
  };

  return sha256Hex(
    JSON.stringify([
      track.lyricsHash,
      track.lrclibAt ?? null,
      canLookUp(tags) ? lookupKeyOf(tags) : null,
    ]),
  );
};
