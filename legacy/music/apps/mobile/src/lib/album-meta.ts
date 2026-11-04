import type { AlbumDetail } from "@music/commands/models";

import { countOf } from "./format";

/** `1991 · TRIP-HOP · 9 SONGS · 45 MIN`, leaving out what the album doesn't know. */
export const albumMeta = (detail: Pick<AlbumDetail, "album" | "genre" | "durationMs" | "tracks">) =>
  [
    detail.album.year === null ? null : String(detail.album.year),
    detail.genre,
    countOf(detail.tracks.length, "song"),
    `${String(Math.max(1, Math.round(detail.durationMs / 60_000)))} min`,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ")
    .toLocaleUpperCase();
