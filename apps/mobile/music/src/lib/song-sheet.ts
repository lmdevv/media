import { Option, Schema, Struct } from "effect";

import { AlbumId, ArtistId, TrackCredits, TrackId } from "@/downloads/sync/models";

import type { Track } from "./models";

/** What the sheet needs to know about the song. */
export type SheetSong = Pick<
  Track,
  "id" | "title" | "artist" | "artistId" | "credits" | "album" | "albumId" | "liked"
>;

const SheetParams = Schema.Struct({
  id: TrackId,
  title: Schema.String,
  artist: Schema.String,
  artistId: ArtistId,
  /** The song's credits as JSON; absent for a song without them, which credits `artistId`. */
  credits: Schema.optionalKey(Schema.fromJsonString(TrackCredits)),
  album: Schema.String,
  albumId: AlbumId,
  liked: Schema.Literals(["1", "0"]),
});

const decodeParams = Schema.decodeUnknownOption(SheetParams);

const encodeParams = Schema.encodeSync(SheetParams);

/** The route params that open the sheet for `song`. */
export const songSheetParams = (song: SheetSong): typeof SheetParams.Encoded =>
  encodeParams({
    ...Struct.pick(song, ["id", "title", "artist", "artistId", "credits", "album", "albumId"]),
    liked: song.liked ? "1" : "0",
  });

/** Route params as Expo Router reads them. */
type RouteParams = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

/** The song the sheet's params describe, or null when they don't describe one. */
export const parseSongSheet = (params: RouteParams): SheetSong | null =>
  Option.getOrNull(
    Option.map(decodeParams(params), ({ liked, ...song }) => ({ ...song, liked: liked === "1" })),
  );
