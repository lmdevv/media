import { useEffect, useLayoutEffect, useRef } from "react";

/** What the system shows and what its buttons do. */
export interface MediaSessionInput {
  readonly title: string;
  /** For an episode, the show. */
  readonly artist: string;
  /** For an episode, its season and number, such as `S1:E3`. */
  readonly album: string;
  /** An absolute artwork URL, or null. */
  readonly artwork: string | null;
  readonly durationSeconds: number;
  readonly positionSeconds: number;
  readonly paused: boolean;
  readonly play: () => void;
  readonly pause: () => void;
  readonly seekTo: (seconds: number) => void;
  /** Plays the previous or next episode; null where there is none. */
  readonly previous: (() => void) | null;
  readonly next: (() => void) | null;
}

const SKIP_SECONDS = 10;

const mediaSession = (): MediaSession | null =>
  "mediaSession" in navigator ? navigator.mediaSession : null;

/** Publishes `input` to the system's media controls while the player is open. */
export const useMediaSession = (input: MediaSessionInput | null): void => {
  const latest = useRef(input);

  useLayoutEffect(() => {
    latest.current = input;
  });

  const title = input?.title;
  const artist = input?.artist;
  const album = input?.album;
  const artwork = input?.artwork ?? null;
  const hasPrevious = input?.previous != null;
  const hasNext = input?.next != null;

  useEffect(() => {
    const session = mediaSession();

    if (session === null || title === undefined) return undefined;

    session.metadata = new MediaMetadata({
      title,
      artist: artist ?? "",
      album: album ?? "",
      artwork: artwork === null ? [] : [{ src: artwork, sizes: "500x750", type: "image/jpeg" }],
    });

    return () => {
      session.metadata = null;
    };
  }, [title, artist, album, artwork]);

  useEffect(() => {
    const session = mediaSession();

    if (session === null) return undefined;

    const position = (): number => latest.current?.positionSeconds ?? 0;

    const handlers: ReadonlyArray<readonly [MediaSessionAction, MediaSessionActionHandler | null]> =
      [
        ["play", () => latest.current?.play()],
        ["pause", () => latest.current?.pause()],
        [
          "seekbackward",
          (details) => latest.current?.seekTo(position() - (details.seekOffset ?? SKIP_SECONDS)),
        ],
        [
          "seekforward",
          (details) => latest.current?.seekTo(position() + (details.seekOffset ?? SKIP_SECONDS)),
        ],
        [
          "seekto",
          (details) => {
            if (details.seekTime !== undefined) latest.current?.seekTo(details.seekTime);
          },
        ],
        ["previoustrack", hasPrevious ? () => latest.current?.previous?.() : null],
        ["nexttrack", hasNext ? () => latest.current?.next?.() : null],
      ];

    for (const [action, handler] of handlers) {
      // Browsers throw for actions they do not know; those simply stay unhandled.
      try {
        session.setActionHandler(action, handler);
      } catch {}
    }

    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [hasPrevious, hasNext]);

  const paused = input?.paused ?? true;
  const duration = input?.durationSeconds ?? 0;
  const second = Math.floor(input?.positionSeconds ?? 0);

  const open = input !== null;

  useEffect(() => {
    const session = mediaSession();

    if (session === null || !open) return;
    session.playbackState = paused ? "paused" : "playing";

    if (duration > 0 && "setPositionState" in session) {
      session.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(duration, Math.max(0, second)),
      });
    }
  }, [open, paused, duration, second]);
};
