/**
 * The player as screens see it, derived from the Convex playback session and this phone's
 * controller. Pure: `PlayerProvider` feeds it and memoizes the parts.
 */
import type { AlbumId, ArtistId, DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import type {
  Device,
  DeviceKind,
  PlaybackState,
  QueueEntry,
  RepeatMode,
} from "@music/commands/models";
import type { ControllerSnapshot } from "@music/player/playback-controller";
import { parseStreamQuality } from "@music/player/stream-quality";
import type { StreamQuality } from "@music/player/stream-quality";
import { resolveMediaUrl } from "../lib/media-url";
import type { ServerOrigin } from "../lib/server";

/** What the player is doing: nothing queued, loading a song, playing, paused, waiting, or failed. */
export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "failed";

/** Where the audio plays: on this phone, on another of the user's devices, or nowhere yet. */
export type PlayerRole =
  | { readonly kind: "local" }
  | {
      readonly kind: "remote";
      readonly device: { readonly id: DeviceId; readonly name: string; readonly kind: DeviceKind };
    }
  | { readonly kind: "none" };

/** The song at the queue's current index. */
export interface NowPlaying {
  readonly itemId: QueueItemId;
  readonly trackId: TrackId;
  readonly title: string;
  readonly artist: string;
  /** Absent for a song someone else's Jam keeps private: there is nothing to open. */
  readonly artistId?: ArtistId;
  readonly album: string;
  readonly albumId?: AlbumId;
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
  readonly trackId: TrackId;
  readonly title: string;
  readonly artist: string;
  readonly artUrl: string | null;
  readonly durationMs: number;
  /** Autoplay added it when the queue ran out. */
  readonly autoplay: boolean;
}

/** What `usePlayer` returns. */
export interface PlayerView {
  readonly status: PlayerStatus;
  readonly role: PlayerRole;
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
  /** This phone listens along to someone else's Jam: the queue and position are the host's. */
  readonly following: boolean;
}

/**
 * The song at the queue's current index, as screens show it. `localArt` is the cover's file on
 * this phone, for a downloaded song: it shows with no connection, unlike the server's.
 */
export const nowPlayingOf = (
  entry: QueueEntry,
  origin: ServerOrigin,
  localArt: string | null = null,
): NowPlaying => {
  const song: NowPlaying = {
    itemId: entry.itemId,
    trackId: entry.id,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    artUrl: localArt ?? resolveMediaUrl(origin, entry.artUrl),
    durationMs: entry.durationMs,
    codec: entry.codec,
    lossless: entry.lossless,
    bitrate: entry.bitrate,
    sampleRate: entry.sampleRate,
    bitDepth: entry.bitDepth,
    liked: entry.liked,
  };

  return entry.withheld === true
    ? song
    : { ...song, artistId: entry.artistId, albumId: entry.albumId };
};

/** A queue entry as the queue shows it; `localArt` as for `nowPlayingOf`. */
export const queueItemOf = (
  entry: QueueEntry,
  origin: ServerOrigin,
  localArt: string | null = null,
): QueueItem => ({
  itemId: entry.itemId,
  trackId: entry.id,
  title: entry.title,
  artist: entry.artist,
  artUrl: localArt ?? resolveMediaUrl(origin, entry.artUrl),
  durationMs: entry.durationMs,
  autoplay: entry.autoplay,
});

export const roleOf = (
  activeDevice: Pick<Device, "id" | "name" | "kind"> | null,
  deviceId: DeviceId,
): PlayerRole => {
  if (activeDevice === null) return { kind: "none" };

  if (activeDevice.id === deviceId) return { kind: "local" };

  return {
    kind: "remote",
    device: { id: activeDevice.id, name: activeDevice.name, kind: activeDevice.kind },
  };
};

/**
 * Whether playback is going, as the play button shows it: this phone's audio when it plays here,
 * else the session, with a play or pause still on its way to the server counted as done.
 */
export const isPlaying = (
  state: PlaybackState | undefined,
  local: ControllerSnapshot,
  role: PlayerRole,
): boolean => {
  if (local.pendingPlaying !== null) return local.pendingPlaying;

  if (role.kind !== "local") return state?.playing ?? false;

  const status = local.engineStatus;

  return (
    status === "playing" ||
    status === "buffering" ||
    (status === "loading" && state?.playing === true)
  );
};

export const statusOf = (
  state: PlaybackState | undefined,
  local: ControllerSnapshot,
  role: PlayerRole,
): PlayerStatus => {
  if (state === undefined) return "loading";

  if (state.queue[state.index] === undefined) return "idle";

  if (role.kind !== "local") return isPlaying(state, local, role) ? "playing" : "paused";

  if (local.engineStatus === "idle") return "loading";

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
 * The `queue.move` arguments that put the entry `itemId` at `toIndex` of `queue` (clamped to the
 * queue), or null when the entry is not queued. The server places an entry after another one, or
 * first without one.
 */
export const moveArgs = (
  queue: ReadonlyArray<{ readonly itemId: QueueItemId }>,
  itemId: QueueItemId,
  toIndex: number,
): { readonly itemId: QueueItemId; readonly afterItemId?: QueueItemId } | null => {
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

/**
 * The saved quality setting. A phone starts on `high` (AAC 320 kbps): lossless originals are a
 * choice in settings, not a surprise on a cellular plan.
 */
export const parseQuality = (stored: string | null): StreamQuality =>
  stored === null ? "high" : parseStreamQuality(stored);
