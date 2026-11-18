import { describe, expect, it } from "vitest";

import { subtitleTrackLabel, subtitleTrackLabels } from "./media-facts";

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
