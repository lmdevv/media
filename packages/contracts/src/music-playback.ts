/**
 * Music's byte routes on the media server, as old music's media service served them: a song's
 * stream at a profile, and album art. Players fetch both by URL, so like movies' media bytes they
 * are plain routes, not `MediaApi` endpoints, and carry their ticket in the `ticket` query
 * parameter (ADR 0011): a song's personal ticket from `music.play.start` or a download, and art's
 * shareable ticket from the music commands.
 */
import { Schema } from "effect";

/** The paths of music's byte routes; `:trackId` and `*` are the route's own parameters. */
export const MUSIC_ROUTES = {
  /** A song's stream: `?ticket=…&p=<profile>`, plus `&start=<ms>` or `&finished=1`. */
  stream: "/media/music/stream/:trackId",
  /** An artwork hash's image: `/music/art/<hash>?ticket=…`. */
  art: "/music/art/*",
} as const;

/** The path of a song's stream, before its query. */
export const musicStreamPath = (trackId: string): string =>
  `/media/music/stream/${encodeURIComponent(trackId)}`;

/**
 * Delivery tier asked of the media server. `original` is direct play; `aac-320` and `aac-128` are
 * fast-start MP4 for `<audio>`. `fmp4-flac` and `fmp4-aac` (AAC 256 kbps) are fragmented MP4 for
 * the gapless MSE engine; their responses carry the sample counts it needs to trim encoder delay
 * (`MusicStreamTimingHeader`).
 */
export const MusicStreamProfile = Schema.Literals([
  "original",
  "aac-320",
  "aac-128",
  "fmp4-flac",
  "fmp4-aac",
]);

/** A delivery tier. */
export type MusicStreamProfile = typeof MusicStreamProfile.Type;

/** The query parameters of a song's stream besides its ticket. */
export const MUSIC_STREAM_PARAMS = {
  /** The profile, `original` when absent. */
  profile: "p",
  /** Milliseconds into the song a transcoded profile starts at, `0` when absent. */
  start: "start",
  /**
   * `1` asks for the finished file: the whole transcode with a length, an `ETag`, and byte ranges,
   * or a `503` with `Retry-After` while the server prepares it in the background. Never a live
   * stream. An original is always finished.
   */
  finished: "finished",
} as const;

/**
 * Response headers of the `fmp4-*` stream profiles, all whole numbers. The fragmented file's
 * timeline starts with `priming` samples of encoder delay, then holds `duration` real samples at
 * `sampleRate` Hz; anything after them is encoder padding.
 *
 * `estimated` is `1` on a stream sent while it is still being transcoded: `duration` is then only
 * the source's declared length, and the stream has no `sidx` index, no `ETag`, and no byte
 * ranges. Once the response ends, a `HEAD` request for the same URL returns the exact timing.
 *
 * `start` is on a stream asked for from an offset (`&start=<ms>` on a transcoded profile): the
 * song sample the stream begins at. Such a stream also carries `priming` and `sampleRate` for
 * every transcoded profile (ADTS too), and an estimated `duration` for the `fmp4-*` profiles. Its
 * fragments sit on the song's own timeline: the first `tfdt` is `start`, and song sample `s` is at
 * `s + priming`, as in the full stream. ADTS has no timestamps: its audio begins with `priming`
 * samples of encoder delay, then song sample `start`.
 */
export const MusicStreamTimingHeader = {
  priming: "X-Music-Priming-Samples",
  duration: "X-Music-Duration-Samples",
  sampleRate: "X-Music-Sample-Rate",
  estimated: "X-Music-Duration-Estimated",
  start: "X-Music-Start-Samples",
} as const;
