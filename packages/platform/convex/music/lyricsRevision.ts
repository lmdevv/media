import { canLookUp, lookupKeyOf } from "@media/contracts/lyrics-lookup";

import type { Doc } from "../_generated/dataModel";
import { sha256Hex } from "../core/lib/secrets";

/**
 * A revision of what `music.lyrics.get` answers for `track`, read from the track alone. It moves
 * with the song's own lyrics (`lyricsHash`, which a scan that reads them rewrites), with an LRCLIB
 * answer that differs from the one stored or is for other tags (`lrclibAt`, which
 * `writeLrclibLyrics` moves only then), and with a retag that makes another LRCLIB lookup key.
 *
 * It leaves out what only switches the answer between `pending` and a settled one: a lookup
 * queued, running, or ending without storing an answer, and lookups turned off or on. A device
 * keeps lyrics it got while a lookup was pending at a revision no server one equals and asks
 * again; a lookup that then stores another answer moves `lrclibAt`, and one that stores the same
 * answer leaves `get` answering what it did before the lookup was queued. It also leaves out an
 * LRCLIB row deleted on its own: only removing the track deletes one.
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
