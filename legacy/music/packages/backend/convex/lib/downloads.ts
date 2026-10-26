/**
 * Download pins: what someone keeps on a device, and what each pin holds for them now. The device
 * owns the files and decides when to fetch; this module only says what a pin means at this moment,
 * so every device (phone, desktop, CLI) reads one answer to re-tags, re-encodes, missing files, and
 * lost access.
 */
import {
  LyricsChange,
  LyricsRevision,
  offlineLyricsOf,
  resolveLyrics,
} from "@music/commands/lyrics";
import type { HeldLyrics } from "@music/commands/lyrics";
import { PLAYLIST_LIMIT } from "@music/commands/models";
import type {
  DownloadManifest,
  DownloadPin,
  DownloadTargetKind,
  ManifestEntryState,
} from "@music/commands/models";
import { fileRevision } from "@music/commands/revision";
import { Match, Schema } from "effect";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { sha256Hex } from "./crypto";
import { tableId } from "./ids";
import { lookupOfRow, lookupRowOf, storedAnswerBytes } from "./lyricLookups";
import { localLyricsOf } from "./lyrics";
import { isClaimed } from "./paths";
import { playlistAccess } from "./playlists";
import { byDiscAndNumber, contributorOf, makePresenter } from "./present";
import type { Presenter } from "./present";
import { inOrder } from "./sequence";
import { canRead } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

/** The song, album, or playlist a pin keeps, as stored. */
export type PinTarget = Doc<"downloadPins">["target"];

/** A pin's target that its owner can read now. */
type OpenedTarget =
  | { readonly kind: "track"; readonly track: Doc<"tracks"> }
  | { readonly kind: "album"; readonly album: Doc<"albums"> }
  | { readonly kind: "playlist"; readonly playlist: Doc<"playlists"> };

/** One song a pin holds, and what the device does with it. */
interface PinnedSong {
  readonly track: Doc<"tracks">;
  readonly state: ManifestEntryState;
}

/** Parses a wire `{ kind, id }` into a target; an ID of another table fails `not_found`. */
export const parseTarget = (ctx: ReadCtx, kind: DownloadTargetKind, id: string): PinTarget =>
  Match.value(kind).pipe(
    Match.when("track", (): PinTarget => ({ kind: "track", id: tableId(ctx, "tracks", id) })),
    Match.when("album", (): PinTarget => ({ kind: "album", id: tableId(ctx, "albums", id) })),
    Match.when("playlist", (): PinTarget => ({
      kind: "playlist",
      id: tableId(ctx, "playlists", id),
    })),
    Match.exhaustive,
  );

/** The pin `userId` has for `target` on a device, if any. */
export const findPin = (
  ctx: ReadCtx,
  userId: Id<"users">,
  deviceId: string,
  target: PinTarget,
): Promise<Doc<"downloadPins"> | null> =>
  ctx.db
    .query("downloadPins")
    .withIndex("by_user_device", (q) =>
      q
        .eq("userId", userId)
        .eq("deviceId", deviceId)
        .eq("target.kind", target.kind)
        .eq("target.id", target.id),
    )
    .unique();

/**
 * The target when it exists and the viewer can read it now: a song or album in a library they
 * can read, a playlist they can open. Null otherwise, which makes the pin unavailable.
 */
export const openTarget = (
  ctx: ReadCtx,
  viewer: Viewer,
  target: PinTarget,
): Promise<OpenedTarget | null> =>
  Match.value(target).pipe(
    Match.discriminatorsExhaustive("kind")({
      track: async ({ id }): Promise<OpenedTarget | null> => {
        const track = await ctx.db.get(id);

        return track === null || !canRead(viewer, track.libraryId)
          ? null
          : { kind: "track", track };
      },
      album: async ({ id }): Promise<OpenedTarget | null> => {
        const album = await ctx.db.get(id);

        return album === null || !canRead(viewer, album.libraryId)
          ? null
          : { kind: "album", album };
      },
      playlist: async ({ id }): Promise<OpenedTarget | null> => {
        const playlist = await ctx.db.get(id);
        const access = playlist === null ? null : await playlistAccess(ctx, viewer, playlist);

        return playlist === null || access === null ? null : { kind: "playlist", playlist };
      },
    }),
  );

/**
 * What a device does with a song it may read. A library whose folder no scan has claimed (a NAS
 * that hasn't remounted) says nothing reliable about its files, so its songs are held whether or
 * not they are marked missing: a device never deletes on what the server can't see.
 */
const stateOf = (
  claimed: ReadonlySet<Id<"libraries">>,
  track: Doc<"tracks">,
): ManifestEntryState => {
  if (!claimed.has(track.libraryId)) return "held";

  return track.missing ? "missing" : "fetchable";
};

/**
 * The songs an opened target holds that the viewer can read, in album or playlist order. An album
 * leaves out songs whose file is gone, as `albums.get` does; a playlist and a single song keep
 * them as `missing`. A song a playlist lists twice is held once, at its first place.
 */
const songsOf = async (
  ctx: ReadCtx,
  viewer: Viewer,
  opened: OpenedTarget,
): Promise<ReadonlyArray<PinnedSong>> => {
  // Every song the viewer can read is in one of these libraries.
  const claimed = new Set(viewer.libraries.filter(isClaimed).map((library) => library._id));
  const song = (track: Doc<"tracks">): PinnedSong => ({ track, state: stateOf(claimed, track) });

  return Match.value(opened).pipe(
    Match.discriminatorsExhaustive("kind")({
      track: async ({ track }) => [song(track)],
      album: async ({ album }) => {
        const tracks = await ctx.db
          .query("tracks")
          .withIndex("by_album", (q) => q.eq("albumId", album._id))
          .collect();

        return tracks
          .toSorted(byDiscAndNumber)
          .map(song)
          .filter((each) => each.state !== "missing");
      },
      playlist: async ({ playlist }) => {
        const items = await ctx.db
          .query("playlistItems")
          .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
          .take(PLAYLIST_LIMIT);

        const tracks = await Promise.all(items.map((item) => ctx.db.get(item.trackId)));
        const seen = new Set<Id<"tracks">>();

        return tracks.flatMap((track) => {
          if (track === null || !canRead(viewer, track.libraryId) || seen.has(track._id)) {
            return [];
          }

          seen.add(track._id);

          return [song(track)];
        });
      },
    }),
  );
};

/** A pin's name and cover. */
interface ShownAs {
  readonly title: string;
  readonly subtitle: string;
  readonly artHash: string | undefined;
}

/**
 * How an opened target is named on its pin. A playlist's cover is the first one among `songs`,
 * the songs it holds when a manifest has read them; `downloads.list` reads none, which keeps a
 * list of hundreds of playlist pins within one query's reads.
 */
const shownAs = (
  ctx: ReadCtx,
  opened: OpenedTarget,
  songs: ReadonlyArray<PinnedSong>,
): Promise<ShownAs> =>
  Match.value(opened).pipe(
    Match.discriminatorsExhaustive("kind")({
      track: async ({ track }): Promise<ShownAs> => ({
        title: track.title,
        subtitle: track.artistName,
        artHash: track.artHash,
      }),
      album: async ({ album }): Promise<ShownAs> => ({
        title: album.title,
        subtitle: album.artistName,
        artHash: album.artHash,
      }),
      playlist: async ({ playlist }): Promise<ShownAs> => {
        const owner = await ctx.db.get(playlist.ownerId);

        return {
          title: playlist.name,
          subtitle: owner === null ? "" : contributorOf(owner).name,
          artHash: songs.find((song) => song.track.artHash !== undefined)?.track.artHash,
        };
      },
    }),
  );

/**
 * A pin as its owner sees it, given its target as `openTarget` found it and, for a manifest, the
 * songs it holds.
 */
export const presentPin = async (
  ctx: ReadCtx,
  present: Presenter,
  pin: Doc<"downloadPins">,
  opened: OpenedTarget | null,
  songs: ReadonlyArray<PinnedSong> = [],
): Promise<(typeof DownloadPin)["Encoded"]> => {
  const fields = {
    id: pin._id,
    deviceId: pin.deviceId,
    target: pin.target,
    createdAt: pin._creationTime,
  };

  if (opened === null) return { ...fields, available: false };
  const shown = await shownAs(ctx, opened, songs);

  return {
    ...fields,
    available: true,
    title: shown.title,
    subtitle: shown.subtitle,
    artUrl: await present.artUrl(shown.artHash),
    artHash: shown.artHash ?? null,
  };
};

/** What a pin holds for its owner now: each song with its file revision and what to do with it. */
export const resolveManifest = async (
  ctx: ReadCtx,
  viewer: Viewer,
  pin: Doc<"downloadPins">,
): Promise<(typeof DownloadManifest)["Encoded"]> => {
  const present = makePresenter(ctx, viewer);
  const opened = await openTarget(ctx, viewer, pin.target);
  const songs = opened === null ? [] : await songsOf(ctx, viewer, opened);

  return {
    pin: await presentPin(ctx, present, pin, opened, songs),
    entries: await Promise.all(
      songs.map(async ({ track, state }) => ({
        track: await present.offlineTrack(track),
        rev: fileRevision(track.size, track.mtimeMs),
        artHash: track.artHash ?? null,
        state,
      })),
    ),
  };
};

/**
 * Moves every pin of album `from` to album `to`, after a re-tag moved its songs there and emptied
 * it. A device that already keeps `to` loses the duplicate. Idempotent.
 */
export const repointAlbumPins = async (
  ctx: MutationCtx,
  from: Id<"albums">,
  to: Id<"albums">,
): Promise<void> => {
  const pins = await ctx.db
    .query("downloadPins")
    .withIndex("by_target", (q) => q.eq("target.kind", "album").eq("target.id", from))
    .collect();

  const target = { kind: "album", id: to } as const;

  // A device keeps an album once, so no two of these pins land on the same row.
  await Promise.all(
    pins.map(async (pin) => {
      const kept = await findPin(ctx, pin.userId, pin.deviceId, target);

      await (kept === null ? ctx.db.patch(pin._id, { target }) : ctx.db.delete(pin._id));
    }),
  );
};

/**
 * Lyrics one `downloads.lyrics` read sends, besides the first song's, as their stored JSON,
 * counted from the sizes songs and lookups keep before any is read. Each song's lyrics are under
 * 2 MiB (a document of its own lyrics and one of LRCLIB's), so with the songs read to compare
 * revisions the read stays well inside Convex's 16 MiB.
 */
const LYRICS_PAGE_BYTES = 8 * 1024 ** 2;

/** Raised when the rules that resolve offline lyrics change, so every device fetches them again. */
const OFFLINE_LYRICS_VERSION = "v2";

const encodeChange = Schema.encodeSync(LyricsChange);

/**
 * What LRCLIB's answer contributes to a revision, read from the lookup's state: a found answer by
 * when it was stored, as storing new lyrics always moves `fetchedAt`; never a pending one.
 */
const answerPart = (lookup: Doc<"lyricLookups"> | null): string => {
  if (lookup?.state.status === "found") return `found:${lookup._id}:${lookup.state.fetchedAt}`;

  if (lookup?.state.status === "instrumental") return `instrumental:${lookup.state.fetchedAt}`;

  return "";
};

/**
 * The revision of a song's offline lyrics, read from the song and its lookup without their
 * lyrics: the content revision of its own lyrics (`tracks.lyricsHash`) and of LRCLIB's answer.
 * Null when there is nothing to keep: no lyrics of its own and no answer from LRCLIB.
 */
const revisionOf = async (
  track: Doc<"tracks">,
  lookup: Doc<"lyricLookups"> | null,
): Promise<LyricsRevision | null> => {
  // Lyrics read before hashes were kept are unchanged since: every scan that writes them hashes them.
  const own = track.lyricsBytes === undefined ? "" : (track.lyricsHash ?? "unhashed");
  const answer = answerPart(lookup);

  if (own === "" && answer === "") return null;
  const digest = await sha256Hex(`${OFFLINE_LYRICS_VERSION}|${own}|${answer}`);

  return LyricsRevision.make(`${OFFLINE_LYRICS_VERSION}-${digest.slice(0, 24)}`);
};

/**
 * How the lyrics of downloaded songs differ from the revisions a device keeps, in the order it
 * asked: new lyrics for a song whose revision moved, and a removal for one that has none now or
 * that the viewer can no longer read. Lyrics are resolved as a device without the server shows
 * them (`offlineLyricsOf`). Once the lyrics sent would pass `LYRICS_PAGE_BYTES`, later changed
 * songs wait: the device asks again with the revisions it then keeps.
 */
export const lyricsChanges = async (
  ctx: ReadCtx,
  viewer: Viewer,
  held: ReadonlyArray<HeldLyrics>,
): Promise<Array<(typeof LyricsChange)["Encoded"]>> => {
  const changes: Array<(typeof LyricsChange)["Encoded"]> = [];
  let sent = 0;

  await inOrder(held, async ({ trackId, rev }) => {
    const id = ctx.db.normalizeId("tracks", trackId);
    const track = id === null ? null : await ctx.db.get(id);

    if (track === null || !canRead(viewer, track.libraryId)) {
      if (rev !== null) changes.push(encodeChange(LyricsChange.cases.Removed.make({ trackId })));

      return;
    }

    // A song's own synced lyrics always win, so LRCLIB's answer can't change what it shows.
    const lookup = track.lyricsSynced === true ? null : await lookupRowOf(ctx, track);
    const current = await revisionOf(track, lookup);

    if (current === rev) return;

    if (current === null) {
      changes.push(encodeChange(LyricsChange.cases.Removed.make({ trackId })));

      return;
    }

    const bytes = (track.lyricsBytes ?? 0) + storedAnswerBytes(lookup);

    if (sent > 0 && sent + bytes > LYRICS_PAGE_BYTES) return;
    sent += bytes;

    const [local, answer] = await Promise.all([
      localLyricsOf(ctx, track._id),
      lookupOfRow(ctx, lookup),
    ]);

    const lyrics = offlineLyricsOf(resolveLyrics(local, answer, { remoteLookups: "off" }));

    changes.push(encodeChange(LyricsChange.cases.Changed.make({ trackId, rev: current, lyrics })));
  });

  return changes;
};
