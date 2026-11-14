/** What the system media controls show of a song. */
export interface NowPlayingTrack {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** Its cover, as a URL the page can load; null for none. */
  readonly artUrl: string | null;
  readonly durationMs: number;
}

/** What the system media controls can ask the player to do. */
export interface MediaSessionHandlers {
  readonly play: () => void;
  readonly pause: () => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly seekTo: (positionMs: number) => void;
}

const session = (): MediaSession | null =>
  "mediaSession" in navigator ? navigator.mediaSession : null;

const setHandler = (
  media: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void => {
  try {
    media.setActionHandler(action, handler);
  } catch {}
};

/** Routes system media controls to `handlers`, or detaches them when `handlers` is null. */
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null): void => {
  const media = session();

  if (media === null) return;

  setHandler(media, "play", handlers === null ? null : () => handlers.play());
  setHandler(media, "pause", handlers === null ? null : () => handlers.pause());
  setHandler(media, "nexttrack", handlers === null ? null : () => handlers.next());
  setHandler(media, "previoustrack", handlers === null ? null : () => handlers.previous());

  setHandler(
    media,
    "seekto",
    handlers === null
      ? null
      : (details) => {
          if (details.seekTime !== undefined) handlers.seekTo(details.seekTime * 1000);
        },
  );
};

/**
 * Shows `track` in the system media controls, or clears them when this browser is not playing
 * anything. `positionMs` feeds the lock screen scrubber.
 */
export const showNowPlaying = (
  track: NowPlayingTrack | null,
  playing: boolean,
  positionMs: number,
): void => {
  const media = session();

  if (media === null) return;

  if (track === null) {
    media.metadata = null;
    media.playbackState = "none";

    return;
  }

  const current = media.metadata;

  if (current?.title !== track.title || current.artist !== track.artist) {
    media.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.artUrl === null ? [] : [{ src: track.artUrl }],
    });
  }

  media.playbackState = playing ? "playing" : "paused";

  if (track.durationMs <= 0) return;

  try {
    media.setPositionState({
      duration: track.durationMs / 1000,
      position: Math.min(Math.max(0, positionMs), track.durationMs) / 1000,
      playbackRate: 1,
    });
  } catch {}
};
