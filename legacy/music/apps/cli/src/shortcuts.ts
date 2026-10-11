/**
 * Shortcuts people and agents reach for most, built only from registry commands.
 */
import type { DeviceId, TrackId } from "@music/commands/ids";
import type {
  AlbumCard,
  ArtistCard,
  PlaybackState,
  SearchResults,
  Track,
} from "@music/commands/models";
import { Clock, Data, Effect } from "effect";

import type { Api } from "./api";
import { CommandFailed } from "./errors";
import { formatDuration } from "./render";

/** What `music play` decided to play. */
export type PlayChoice = Data.TaggedEnum<{
  Album: { readonly album: AlbumCard };
  Artist: { readonly artist: ArtistCard };
  Tracks: { readonly tracks: ReadonlyArray<Track> };
}>;

export const PlayChoice = Data.taggedEnum<PlayChoice>();

/** Lowercase, accents stripped, punctuation folded to spaces. */
const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * How well `query` names something with this title and optional artist, from 0 (no match) to 5
 * (exact title, with or without the artist).
 */
export const matchScore = (query: string, title: string, artist: string | null): number => {
  const q = normalize(query).replace(/ by /u, " ");
  const t = normalize(title);
  const a = artist === null ? "" : normalize(artist);

  if (q.length === 0 || t.length === 0) return 0;

  if (q === t || (a.length > 0 && (q === `${t} ${a}` || q === `${a} ${t}`))) return 5;

  if (a.length > 0 && q.includes(t) && q.includes(a)) return 4;

  if (t.startsWith(q)) return 3;

  if (t.includes(q)) return 2;

  return q.includes(t) ? 1 : 0;
};

const best = <A>(
  items: ReadonlyArray<A>,
  score: (item: A) => number,
): { readonly item: A; readonly score: number } | null => {
  let winner: { readonly item: A; readonly score: number } | null = null;

  for (const item of items) {
    const value = score(item);

    if (winner === null || value > winner.score) winner = { item, score: value };
  }

  return winner;
};

/**
 * Picks what to play for a query: an album when it matches better than any song, an artist's top
 * songs when the artist matches best, otherwise the matching songs with the best one first.
 */
export const choosePlay = (query: string, results: SearchResults): PlayChoice | null => {
  const trackScore = (track: Track): number => matchScore(query, track.title, track.artist);
  const album = best(results.albums, (item) => matchScore(query, item.title, item.artist));
  const artist = best(results.artists, (item) => matchScore(query, item.name, null));
  const track = best(results.tracks, trackScore);
  const trackBest = track?.score ?? -1;

  if (artist !== null && artist.score > trackBest && artist.score > (album?.score ?? -1)) {
    return PlayChoice.Artist({ artist: artist.item });
  }

  if (album !== null && album.score > trackBest) return PlayChoice.Album({ album: album.item });

  if (track === null) return null;

  const rest = results.tracks.filter((candidate) => candidate !== track.item);

  return PlayChoice.Tracks({ tracks: [track.item, ...rest] });
};

/** The outcome of `music play`, printed as JSON with `--json`. A type alias so it stays JSON. */
export type Played = {
  readonly kind: "album" | "artist" | "tracks";
  readonly id: string | null;
  readonly title: string;
  readonly trackIds: ReadonlyArray<TrackId>;
};

const trackIdsOf = (tracks: ReadonlyArray<Track>): ReadonlyArray<TrackId> =>
  tracks.map((track) => track.id);

/** Searches, picks with `choosePlay`, and replaces the queue with the result. */
export const play = Effect.fn("Shortcuts.play")(function* (
  api: Api,
  query: string,
  deviceId: DeviceId | null,
) {
  const results = yield* api.read("search", { query, limit: 20 });
  const choice = choosePlay(query, results);

  if (choice === null) {
    return yield* new CommandFailed({ code: "not_found", message: `Nothing matches "${query}"` });
  }

  const played: Played = yield* PlayChoice.$match(choice, {
    Album: ({ album }) =>
      api.read("albums.get", { albumId: album.id }).pipe(
        Effect.map((detail): Played => ({
          kind: "album",
          id: album.id,
          title: `${album.title} by ${album.artist}`,
          trackIds: trackIdsOf(detail.tracks),
        })),
      ),
    Artist: ({ artist }) =>
      api.read("artists.get", { artistId: artist.id }).pipe(
        Effect.map((detail): Played => ({
          kind: "artist",
          id: artist.id,
          title: `${artist.name}: top songs`,
          trackIds: trackIdsOf(detail.topTracks),
        })),
      ),
    Tracks: ({ tracks }) =>
      Effect.succeed<Played>({
        kind: "tracks",
        id: tracks[0]?.id ?? null,
        title: tracks[0] === undefined ? query : `${tracks[0].title} by ${tracks[0].artist}`,
        trackIds: trackIdsOf(tracks),
      }),
  });

  const [first, ...others] = played.trackIds;

  if (first === undefined) {
    return yield* new CommandFailed({
      code: "not_found",
      message: `${played.title} has no songs to play`,
    });
  }

  yield* api.run(
    "playback.play",
    deviceId === null
      ? { trackIds: [first, ...others] }
      : { trackIds: [first, ...others], deviceId },
  );

  return played;
});

/** The live position: `positionMs` was true at `updatedAt` and advances while playing. */
export const livePosition = (state: PlaybackState, now: number): number => {
  const current = state.queue[state.index];
  const elapsed = state.playing ? Math.max(0, now - state.updatedAt) : 0;
  const position = state.positionMs + elapsed;

  return current === undefined ? position : Math.min(position, current.durationMs);
};

/** A few lines describing the playback session. */
export const describePlayback = (state: PlaybackState, now: number): string => {
  const current = state.queue[state.index];

  if (current === undefined) return "Nothing is playing.";

  const device =
    state.activeDevice === null
      ? "no active device"
      : `on ${state.activeDevice.name} (${state.activeDevice.kind})`;

  return [
    `${state.playing ? "▶" : "⏸"} ${current.title} — ${current.artist}`,
    `  ${current.album} · ${formatDuration(livePosition(state, now))} / ${formatDuration(current.durationMs)}`,
    `  ${device} · ${String(state.index + 1)} of ${String(state.queue.length)} in queue · shuffle ${state.shuffle ? "on" : "off"} · repeat ${state.repeat} · volume ${String(Math.round(state.volume * 100))}%`,
    `  track ${current.id}`,
  ].join("\n");
};

/** Reads the playback state and the current time for `music now`. */
export const now = Effect.fn("Shortcuts.now")(function* (api: Api) {
  const state = yield* api.read("playback.state", {});
  const time = yield* Clock.currentTimeMillis;

  return { state, text: describePlayback(state, time) };
});
