import type { TrackLyrics } from "@media/player/lyrics";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LyricsPane } from "./lyrics-view";

/** What the lyrics pane says for `lyrics`, without tags, entities decoded, spaces folded. */
const shown = (lyrics: TrackLyrics): string =>
  renderToStaticMarkup(<LyricsPane lyrics={lyrics} layout="desktop" />)
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

const ownWords = {
  kind: "main" as const,
  lang: null,
  origin: { type: "embedded" as const, tag: "vorbis:LYRICS" as const },
  body: { type: "plain" as const, text: "Our own words" },
};

describe("LyricsPane", () => {
  it("says a song LRCLIB calls instrumental is, and one without lyrics has none", () => {
    expect(shown({ status: "instrumental" })).toBe("Instrumental");
    expect(shown({ status: "none" })).toBe("No lyrics for this song");
  });

  it("looks for lyrics while LRCLIB is asked, showing the song's own words meanwhile", () => {
    expect(shown({ status: "pending", fallback: null })).toContain("Looking for lyrics…");

    const meanwhile = shown({ status: "pending", fallback: ownWords });

    expect(meanwhile).toContain("Our own words");
    expect(meanwhile).toContain("Looking for synced lyrics…");
  });

  it("shows LRCLIB's plain lyrics as the song's own", () => {
    const fromLrclib = shown({
      status: "plain",
      source: "lrclib",
      main: {
        ...ownWords,
        origin: { type: "lrclib", recordId: 7 },
        body: { type: "plain", text: "Found online" },
      },
      extras: [],
    });

    expect(fromLrclib).toBe("Found online");
  });
});
