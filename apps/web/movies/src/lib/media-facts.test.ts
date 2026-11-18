import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { asTitleId } from "./catalog";
import type { MediaFile, MediaFileId, MediaVersion } from "./catalog";
import { fileBadges, subtitleTrackLabel, subtitleTrackLabels, versionBadges } from "./media-facts";

const english = {
  language: "eng",
  hearingImpaired: false,
  forced: false,
  kind: "text",
  codec: "subrip",
} as const;

const pgs = { ...english, kind: "bitmap", codec: "hdmv_pgs_subtitle" } as const;

describe("subtitleTrackLabel", () => {
  it("names text tracks by language, with CC and Forced", () => {
    expect(subtitleTrackLabel(english, 0)).toBe("English");
    expect(subtitleTrackLabel({ ...english, hearingImpaired: true }, 0)).toBe("English CC");
    expect(subtitleTrackLabel({ ...english, forced: true }, 0)).toBe("English (Forced)");
  });

  it("marks picture tracks with their format, in one group with Forced", () => {
    expect(subtitleTrackLabel(pgs, 1)).toBe("English (PGS)");
    expect(subtitleTrackLabel({ ...pgs, codec: "dvd_subtitle" }, 1)).toBe("English (VobSub)");
    expect(subtitleTrackLabel({ ...pgs, forced: true }, 1)).toBe("English (Forced, PGS)");
    expect(subtitleTrackLabel({ ...pgs, hearingImpaired: true, forced: true }, 1)).toBe(
      "English CC (Forced, PGS)",
    );
  });
});

describe("subtitleTrackLabels", () => {
  it("tells apart tracks that would read the same, by title and then by position", () => {
    expect(
      subtitleTrackLabels([
        english,
        pgs,
        { ...pgs, title: "Commentary" },
        { ...english, language: undefined },
        { ...english, language: undefined },
      ]),
    ).toStrictEqual([
      "English",
      "English (PGS)",
      "English (PGS) · Commentary",
      "Subtitles 4",
      "Subtitles 5",
    ]);
    expect(subtitleTrackLabels([english, english])).toStrictEqual(["English · 1", "English · 2"]);
  });

  it("never returns two equal labels, even when a title looks like a suffix", () => {
    const labels = subtitleTrackLabels([
      english,
      english,
      { ...english, language: undefined, title: "English · 1" },
    ]);

    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("versionBadges", () => {
  const fileId = Brand.nominal<MediaFileId>()("file");

  const file: MediaFile = {
    id: fileId,
    titleId: asTitleId("title"),
    episodeId: null,
    versionName: null,
    sizeBytes: 1,
    probe: {
      container: "matroska",
      durationMs: 60_000,
      bitRate: null,
      video: [
        {
          index: 0,
          codec: "hevc",
          profile: "Main 10",
          width: 3840,
          height: 2160,
          frameRate: 24,
          bitDepth: 10,
          pixelFormat: null,
          hdr: "hdr10",
          bitRate: null,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "aac",
          profile: null,
          channels: 2,
          channelLayout: null,
          language: "eng",
          title: null,
          default: false,
          bitRate: null,
        },
        {
          index: 2,
          codec: "eac3",
          profile: null,
          channels: 6,
          channelLayout: null,
          language: "eng",
          title: null,
          default: true,
          bitRate: null,
        },
      ],
      subtitles: [],
      chapters: [],
    },
    externalSubtitles: [],
    hdr: true,
    trickplay: null,
  };

  // What `movies.titles.versions` answers for `file`: its first video and its default audio.
  const version: MediaVersion = {
    id: fileId,
    versionName: null,
    width: 3840,
    height: 2160,
    hdr: "hdr10",
    videoCodec: "hevc",
    videoProfile: "Main 10",
    videoLevel: null,
    videoBitDepth: 10,
    audioCodec: "eac3",
    audioChannels: 6,
    audioTracks: 2,
    container: "matroska",
    sizeBytes: 1,
    durationMs: 60_000,
    lastPlayed: false,
  };

  it("reads the badges of a version as of its file", () => {
    expect(versionBadges(version)).toStrictEqual(fileBadges(file));
    expect(versionBadges(version).length).toBe(4);
  });

  it("leaves out the video badges of a version with no video", () => {
    const audioOnly: MediaVersion = {
      ...version,
      width: null,
      height: null,
      hdr: "none",
      videoCodec: null,
    };

    expect(versionBadges(audioOnly)).toStrictEqual(
      fileBadges({ ...file, probe: { ...file.probe, video: [] } }),
    );
  });
});
