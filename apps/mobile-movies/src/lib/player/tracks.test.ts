import { describe, expect, it } from "vitest";

import { languageName } from "../languages";
import { audioTrackLabels, subtitleTrackLabels } from "./tracks";

const subtitle = {
  language: "eng",
  hearingImpaired: false,
  forced: false,
  kind: "text",
  codec: "subrip",
} as const;

describe("languageName", () => {
  it("names languages in their own words from either code", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("spa")).toBe("Español");
    expect(languageName("ger")).toBe("Deutsch");
    expect(languageName("pt-BR")).toBe("Português");
  });

  it("shows an unknown code and nothing for undetermined", () => {
    expect(languageName("tlh")).toBe("TLH");
    expect(languageName("und")).toBeNull();
    expect(languageName(null)).toBeNull();
  });
});

describe("audioTrackLabels", () => {
  it("names tracks by language and channels, or language and title", () => {
    expect(
      audioTrackLabels([
        { language: "eng", title: null, channels: 6 },
        { language: "eng", title: null, channels: 2 },
        { language: "eng", title: "Audio Description", channels: 2 },
        { language: null, title: null, channels: 1 },
      ]),
    ).toStrictEqual([
      "English · 5.1",
      "English · Stereo",
      "English · Audio Description",
      "Track 4 · Mono",
    ]);
  });

  it("tells identical tracks apart by position", () => {
    expect(
      audioTrackLabels([
        { language: "eng", title: null, channels: 2 },
        { language: "eng", title: null, channels: 2 },
      ]),
    ).toStrictEqual(["English · Stereo (1)", "English · Stereo (2)"]);
  });
});

describe("subtitleTrackLabels", () => {
  it("marks SDH, forced, titled, and picture tracks", () => {
    expect(
      subtitleTrackLabels([
        { ...subtitle, hearingImpaired: true },
        { ...subtitle, language: "spa" },
        { ...subtitle, forced: true },
        { ...subtitle, title: "Commentary" },
        { ...subtitle, kind: "bitmap", codec: "hdmv_pgs_subtitle" },
        { ...subtitle, kind: "bitmap", codec: "dvd_subtitle", title: "English (image)" },
        { ...subtitle, language: undefined, title: undefined },
      ]),
    ).toStrictEqual([
      "English · SDH",
      "Español",
      "English · Forced",
      "English · Commentary",
      "English · PGS",
      "English · VobSub",
      "Subtitles 7",
    ]);
  });
});
