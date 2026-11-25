import type { ShownCredit } from "@media/contracts/artist-credits";
import type { ControllerSnapshot, QueueEntry } from "@media/player/playback-controller";
import type { RepeatMode } from "@media/player/queue-order";
import type { StreamQuality } from "@media/player/stream-quality";
import { Struct } from "effect";

import { creditText } from "../lib/credits";
import { asQueueItemId } from "../lib/models";
import type { AlbumId, ArtistId, QueueItemId, Track, TrackId } from "../lib/models";

/** What the player is doing: nothing queued, loading a song, playing, paused, waiting, or failed. */
export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "failed";

/** A song as the player plays it: the core's song, or this phone's copy of it offline. */
export type PlayerTrack = Track;

export interface NowPlaying {
  readonly itemId: QueueItemId;
  readonly trackId: TrackId;
  readonly title: string;
  readonly artist: string;
  readonly artistId: ArtistId;
  /**
   * Every artist the song credits, in order; absent for a song without credits, which credits
   * `artistId`.
   */
  readonly credits?: ReadonlyArray<ShownCredit<ArtistId>>;
  readonly album: string;
  readonly albumId: AlbumId;
  /** Absolute, ready for an image. */
  readonly artUrl: string | null;
  readonly durationMs: number;
  /** As the scanner names it, such as "FLAC" or "MPEG 1 Layer 3". */
  readonly codec: string;
  readonly lossless: boolean;
  readonly bitrate: number | null;
  readonly sampleRate: number | null;
  readonly bitDepth: number | null;
  readonly liked: boolean;
}

/** One entry of the queue. */
export interface QueueItem {
  readonly itemId: QueueItemId;
  /** Null for a Jam's song this person may not play, which shows as `Hidden song`. */
  readonly trackId: TrackId | null;
  readonly title: string;
  /** The song's artists as one line, as a row shows them. */
  readonly artist: string;
  readonly artUrl: string | null;
  readonly durationMs: number;
  /** Autoplay added it when the queue ran out. */
  readonly autoplay: boolean;
}

/** Another of the person's devices, which the player follows and controls. */
export interface RemoteDevice {
  readonly id: string;
  readonly name: string;
}

/** What `usePlayer` returns. */
export interface PlayerView {
  readonly status: PlayerStatus;
  /**
   * The device that plays the queue while nothing plays on this phone. While it is set, the
   * status, the position, play, pause, seek, and skips follow and control it (ADR 0018). Null while
   * playback is here or nowhere.
   */
  readonly remote: RemoteDevice | null;
  readonly nowPlaying: NowPlaying | null;
  readonly queue: ReadonlyArray<QueueItem>;
  readonly index: number;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  readonly autoplay: boolean;
  readonly volume: number;
  /** The last failure to show, such as a refused command or a stream that could not play. */
  readonly error: string | null;
  /** This phone's streaming quality setting; a change applies from the next song. */
  readonly quality: StreamQuality;
}

/**
 * The song of `entry`, as screens show it. `art` turns a cover's path on the media server into an
 * absolute URL, or names this phone's copy of it for a downloaded song: that one shows with no
 * connection, unlike the server's.
 */
export const nowPlayingOf = (
  entry: QueueEntry<PlayerTrack>,
  art: (track: PlayerTrack) => string | null,
): NowPlaying => ({
  itemId: asQueueItemId(entry.itemId),
  trackId: entry.track.id,
  ...Struct.pick(entry.track, ["title", "artist", "artistId", "credits", "album", "albumId"]),
  artUrl: art(entry.track),
  durationMs: entry.track.durationMs,
  codec: entry.track.codec,
  lossless: entry.track.lossless,
  bitrate: entry.track.bitrate,
  sampleRate: entry.track.sampleRate,
  bitDepth: entry.track.bitDepth,
  liked: entry.track.liked,
});

/**
 * Whether two answers from `nowPlayingOf` read the same, as JSON: it builds each from a song's
 * fields in their order.
 */
export const sameSong = (a: NowPlaying | null, b: NowPlaying | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const queueItemOf = (
  entry: QueueEntry<PlayerTrack>,
  art: (track: PlayerTrack) => string | null,
): QueueItem => ({
  itemId: asQueueItemId(entry.itemId),
  trackId: entry.track.id,
  title: entry.track.title,
  artist: creditText(entry.track),
  artUrl: art(entry.track),
  durationMs: entry.track.durationMs,
  autoplay: entry.autoplay,
});

/**
 * Whether playback is going, as the play button shows it: this phone's audio, with a song still
 * loading to play counted as playing.
 */
export const isPlaying = (local: ControllerSnapshot, wantsPlay: boolean): boolean =>
  local.engineStatus === "playing" ||
  local.engineStatus === "buffering" ||
  (local.engineStatus === "loading" && wantsPlay);

/**
 * What the player shows, from the queue (null before it arrives), and this phone's audio or, while
 * the player follows another device, whether that device plays.
 */
export const statusOf = (
  queue: { readonly hasCurrent: boolean } | null,
  local: ControllerSnapshot,
  remote: { readonly playing: boolean } | null,
): PlayerStatus => {
  if (queue === null) return "loading";

  if (!queue.hasCurrent) return "idle";

  if (remote !== null) return remote.playing ? "playing" : "paused";

  if (local.engineStatus === "idle") return "paused";

  return local.engineStatus === "error" ? "failed" : local.engineStatus;
};

const REPEAT_AFTER: Readonly<Record<RepeatMode, RepeatMode>> = {
  off: "all",
  all: "one",
  one: "off",
};

/** Repeat cycles off, all, one. */
export const nextRepeat = (mode: RepeatMode): RepeatMode => REPEAT_AFTER[mode];

/**
 * The `music.queue.move` arguments that put the entry `itemId` at `toIndex` of `queue` (clamped to
 * the queue), or null when the entry is not queued. The core places an entry after another one, or
 * first without one.
 */
export const moveArgs = <Id extends string>(
  queue: ReadonlyArray<{ readonly itemId: Id }>,
  itemId: Id,
  toIndex: number,
): { readonly itemId: Id; readonly afterItemId?: Id } | null => {
  if (!queue.some((entry) => entry.itemId === itemId)) return null;
  const rest = queue.filter((entry) => entry.itemId !== itemId);
  const index = Math.min(Math.max(0, Math.trunc(toIndex)), rest.length);
  const after = rest[index - 1];

  return after === undefined ? { itemId } : { itemId, afterItemId: after.itemId };
};

/**
 * Whether iOS plays a MIME type (from `codecMimeType`) as it is: AVPlayer decodes AAC, ALAC, MP3,
 * FLAC, and WAV, but not Ogg (Vorbis or Opus).
 */
export const playsOnIos = (mimeType: string): boolean =>
  ["audio/mp4", "audio/flac", "audio/mpeg", "audio/wav"].some((type) => mimeType.startsWith(type));
