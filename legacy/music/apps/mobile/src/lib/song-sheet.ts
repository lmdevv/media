/**
 * The song a Song actions sheet (A11) is about, carried in its route params: there is no command
 * that reads one song, and params keep the route a plain link. `liked` is the list's live value
 * when the sheet opened; `likes.set` sets rather than toggles, so a stale value can't flip a like.
 */
import { AlbumId, ArtistId, TrackId } from "@music/commands/ids";
import type { Track } from "@music/commands/models";
import { Option, Schema } from "effect";

/** What the sheet needs to know about the song. */
export type SheetSong = Pick<
  Track,
  "id" | "title" | "artist" | "artistId" | "album" | "albumId" | "liked"
>;

const SheetParams = Schema.Struct({
  id: TrackId,
  title: Schema.String,
  artist: Schema.String,
  artistId: ArtistId,
  album: Schema.String,
  albumId: AlbumId,
  liked: Schema.Literals(["1", "0"]),
});

const decodeParams = Schema.decodeUnknownOption(SheetParams);

/** The route params that open the sheet for `song`. */
export const songSheetParams = (song: SheetSong): typeof SheetParams.Encoded => ({
  id: song.id,
  title: song.title,
  artist: song.artist,
  artistId: song.artistId,
  album: song.album,
  albumId: song.albumId,
  liked: song.liked ? "1" : "0",
});

/** Route params as Expo Router reads them. */
type RouteParams = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

/** The song the sheet's params describe, or null when they don't describe one. */
export const parseSongSheet = (params: RouteParams): SheetSong | null =>
  Option.getOrNull(
    Option.map(decodeParams(params), ({ liked, ...song }) => ({ ...song, liked: liked === "1" })),
  );
