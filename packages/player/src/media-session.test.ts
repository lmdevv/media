import { afterEach, describe, expect, it, vi } from "vitest";

import { showNowPlaying } from "./media-session";

const COVER = "http://lar.local/music/art/ab12?ticket=t1.week-one";

const song = {
  title: "Song",
  artist: "Artist",
  album: "Album",
  artUrl: COVER,
  durationMs: 0,
};

/** The browser's Media Session, as far as `showNowPlaying` writes it. */
class FakeMediaSession {
  metadata: FakeMediaMetadata | null = null;
  playbackState = "none";
}

/** The browser's `MediaMetadata`, as far as these tests read it. */
class FakeMediaMetadata {
  readonly artwork: readonly MediaImage[];

  constructor(init: MediaMetadataInit) {
    this.artwork = init.artwork ?? [];
  }
}

const stubMediaSession = () => {
  const media = new FakeMediaSession();

  vi.stubGlobal("navigator", { mediaSession: media });
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);

  return media;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showNowPlaying", () => {
  it("offers the system controls each resized cover with its size, never the original", () => {
    const media = stubMediaSession();

    showNowPlaying(song, true, 0);

    expect(media.metadata?.artwork).toEqual(
      [185, 342, 500, 780, 1280].map((width) => ({
        src: `${COVER}&w=${String(width)}`,
        sizes: `${String(width)}x${String(width)}`,
      })),
    );
  });

  it("offers no artwork for a song without a cover", () => {
    const media = stubMediaSession();

    showNowPlaying({ ...song, artUrl: null }, true, 0);

    expect(media.metadata?.artwork).toEqual([]);
  });
});
