import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES } from "../preferences";
import { preferredTracks } from "./preferred-tracks";

const audio = [
  { index: 1, language: "eng", title: null, default: true },
  { index: 2, language: "eng", title: "Audio Description", default: false },
  { index: 3, language: "spa", title: null, default: false },
  { index: 4, language: "spa", title: "Commentary", default: false },
];

const subtitles = [
  { id: "e5", language: "eng", forced: true, hearingImpaired: false, kind: "text" },
  { id: "e6", language: "eng", forced: false, hearingImpaired: true, kind: "text" },
  { id: "e7", language: "eng", forced: false, hearingImpaired: false, kind: "bitmap" },
  { id: "e8", language: "eng", forced: false, hearingImpaired: false, kind: "text" },
  { id: "e9", language: "spa", forced: false, hearingImpaired: false, kind: "text" },
] as const;

describe("preferred tracks", () => {
  it("keeps the stream's own tracks by default", () => {
    expect(preferredTracks(DEFAULT_PREFERENCES, audio, subtitles)).toStrictEqual({
      audioStreamIndex: null,
      subtitleId: null,
    });
  });

  it("picks the preferred audio language, its first plain track first", () => {
    expect(
      preferredTracks({ ...DEFAULT_PREFERENCES, audioLanguage: "es" }, audio, subtitles)
        .audioStreamIndex,
    ).toBe(3);
    expect(
      preferredTracks({ ...DEFAULT_PREFERENCES, audioLanguage: "ja" }, audio, subtitles)
        .audioStreamIndex,
    ).toBeNull();
  });

  it("reads only a capital AD as audio description", () => {
    const tracks = [
      { index: 1, language: "eng", title: "Ad-free mix", default: true },
      { index: 2, language: "eng", title: "English AD", default: false },
    ];

    expect(
      preferredTracks({ ...DEFAULT_PREFERENCES, audioLanguage: "en" }, tracks, []).audioStreamIndex,
    ).toBe(1);
    expect(
      preferredTracks(
        { ...DEFAULT_PREFERENCES, audioLanguage: "en", audioDescription: true },
        tracks,
        [],
      ).audioStreamIndex,
    ).toBe(2);
  });

  it("picks audio description when asked, in the file's language without a preference", () => {
    expect(
      preferredTracks({ ...DEFAULT_PREFERENCES, audioDescription: true }, audio, subtitles)
        .audioStreamIndex,
    ).toBe(2);
    expect(
      preferredTracks(
        { ...DEFAULT_PREFERENCES, audioLanguage: "en", audioDescription: true },
        audio,
        subtitles,
      ).audioStreamIndex,
    ).toBe(2);
  });

  it("picks subtitles in the language, text over pictures, SDH only when asked, never forced", () => {
    const english = { ...DEFAULT_PREFERENCES, subtitleLanguage: "en" };

    expect(preferredTracks(english, audio, subtitles).subtitleId).toBe("e8");
    expect(preferredTracks({ ...english, subtitlesSdh: true }, audio, subtitles).subtitleId).toBe(
      "e6",
    );
    expect(
      preferredTracks({ ...DEFAULT_PREFERENCES, subtitleLanguage: "es" }, audio, subtitles)
        .subtitleId,
    ).toBe("e9");
    expect(
      preferredTracks({ ...DEFAULT_PREFERENCES, subtitleLanguage: "fr" }, audio, subtitles)
        .subtitleId,
    ).toBeNull();
  });
});
