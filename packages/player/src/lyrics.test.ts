import { NotFound } from "@media/contracts/errors";
import { TransportError } from "@media/sdk/effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { lyricLineState, lyricsAnswer, lyricsButton, lyricsMoment, lyricsOffer } from "./lyrics";
import type { TrackLyrics } from "./lyrics";

const line = (startMs: number, endMs: number | null = null) => ({
  text: "Line",
  startMs,
  endMs,
  words: null,
  voice: null,
});

const synced: TrackLyrics = {
  status: "synced",
  source: "file",
  main: {
    kind: "main",
    lang: null,
    origin: { type: "sidecar", fileName: "Song.lrc", format: "lrc" },
    body: { type: "synced", lines: [line(0)] },
  },
  extras: [],
};

const plain: TrackLyrics = {
  status: "plain",
  source: "file",
  main: {
    kind: "main",
    lang: null,
    origin: { type: "embedded", tag: "vorbis:LYRICS" },
    body: { type: "plain", text: "Words" },
  },
  extras: [],
};

const retry = (): void => undefined;

describe("lyricsOffer", () => {
  it("offers synced and plain lyrics, and is loading before the first answer", () => {
    expect(lyricsOffer(lyricsAnswer({ status: "success", data: synced }))).toBe("ready");
    expect(lyricsOffer(lyricsAnswer({ status: "success", data: plain }))).toBe("ready");
    expect(lyricsOffer(lyricsAnswer({ status: "loading" }))).toBe("loading");
  });

  it("offers nothing for a song without lyrics or one this person can't see", () => {
    expect(lyricsOffer(lyricsAnswer({ status: "success", data: { status: "none" } }))).toBe("none");
    expect(
      lyricsAnswer({
        status: "error",
        error: new NotFound({ message: "Track not found" }),
        retry,
      }),
    ).toStrictEqual({ status: "none" });
  });

  it("is still finding the lyrics while LRCLIB is asked, and offers nothing for an instrumental", () => {
    expect(
      lyricsOffer(lyricsAnswer({ status: "success", data: { status: "pending", fallback: null } })),
    ).toBe("loading");
    expect(
      lyricsOffer(
        lyricsAnswer({ status: "success", data: { status: "pending", fallback: plain.main } }),
      ),
    ).toBe("loading");
    expect(lyricsOffer(lyricsAnswer({ status: "success", data: { status: "instrumental" } }))).toBe(
      "instrumental",
    );
    expect(lyricsOffer({ ...synced, source: "lrclib" })).toBe("ready");
  });

  it("tells a failed read apart from a song without lyrics", () => {
    const dropped = new TransportError({
      operation: "music.lyrics.get",
      message: "Network error",
      cause: null,
    });

    expect(lyricsAnswer({ status: "error", error: dropped, retry })).toBe("failed");
    expect(lyricsOffer("failed")).toBe("failed");
  });
});

describe("lyricsButton", () => {
  it("opens lyrics that are ready, being found, or failed to load", () => {
    expect(lyricsButton("ready", false)).toStrictEqual({
      label: "Lyrics",
      disabled: false,
      loading: false,
    });
    expect(lyricsButton("loading", false)).toStrictEqual({
      label: "Loading lyrics",
      disabled: false,
      loading: true,
    });
    expect(lyricsButton("failed", false)).toStrictEqual({
      label: "Lyrics (couldn't load them)",
      disabled: false,
      loading: false,
    });
  });

  it("is dimmed for a song without lyrics or an instrumental", () => {
    expect(lyricsButton("none", false)).toStrictEqual({
      label: "No lyrics for this song",
      disabled: true,
      loading: false,
    });
    expect(lyricsButton("instrumental", false)).toStrictEqual({
      label: "Instrumental, no lyrics",
      disabled: true,
      loading: false,
    });
  });

  it("always hides open lyrics, even after they went away", () => {
    for (const offer of ["ready", "loading", "failed", "none", "instrumental"] as const) {
      expect(lyricsButton(offer, true)).toMatchObject({ label: "Hide lyrics", disabled: false });
    }
  });
});

describe("lyricsMoment", () => {
  const lines = [line(1000), line(3500), line(6000)];

  it("starts nothing before the first line and sings the last started line after", () => {
    expect(lyricsMoment(lines, 0)).toStrictEqual({ started: -1, sung: false });
    expect(lyricsMoment(lines, 999)).toStrictEqual({ started: -1, sung: false });
    expect(lyricsMoment(lines, 1000)).toStrictEqual({ started: 0, sung: true });
    expect(lyricsMoment(lines, 3499)).toStrictEqual({ started: 0, sung: true });
    expect(lyricsMoment(lines, 3500)).toStrictEqual({ started: 1, sung: true });
    expect(lyricsMoment(lines, 600_000)).toStrictEqual({ started: 2, sung: true });
  });

  it("picks the later of lines that start together", () => {
    expect(lyricsMoment([line(0), line(2000), line(2000), line(4000)], 2500).started).toBe(2);
  });

  it("sings no line in a gap after a line's own end", () => {
    const gapLines = [
      { text: "First", startMs: 1000, endMs: 2000, words: null, voice: null },
      { text: "Next", startMs: 10_000, endMs: null, words: null, voice: null },
    ];

    expect(lyricsMoment(gapLines, 1999)).toStrictEqual({ started: 0, sung: true });
    expect(lyricsMoment(gapLines, 2000)).toStrictEqual({ started: 0, sung: false });
    expect(lyricsMoment(gapLines, 5000)).toStrictEqual({ started: 0, sung: false });
    expect(lyricsMoment(gapLines, 10_000)).toStrictEqual({ started: 1, sung: true });
  });

  it("matches the last started line, sung until its end, for any sorted lines and position", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            startMs: fc.integer({ min: 0, max: 600_000 }),
            lengthMs: fc.option(fc.integer({ min: 1, max: 20_000 })),
          }),
          { maxLength: 200 },
        ),
        fc.integer({ min: -1000, max: 700_000 }),
        (cues, positionMs) => {
          const sorted = cues
            .toSorted((a, b) => a.startMs - b.startMs)
            .map(({ startMs, lengthMs }) =>
              line(startMs, lengthMs === null ? null : startMs + lengthMs),
            );

          const started = sorted.findLastIndex((entry) => entry.startMs <= positionMs);
          const endMs = sorted[started]?.endMs ?? null;

          expect(lyricsMoment(sorted, positionMs)).toStrictEqual({
            started,
            sung: started >= 0 && (endMs === null || positionMs < endMs),
          });
        },
      ),
    );
  });
});

describe("lyricLineState", () => {
  it("marks the sung line active, earlier lines past, and later lines upcoming", () => {
    const moment = { started: 1, sung: true };

    expect([0, 1, 2].map((index) => lyricLineState(index, moment))).toStrictEqual([
      "past",
      "active",
      "upcoming",
    ]);
  });

  it("has no active line before the first line or in a gap after a line's own end", () => {
    expect(lyricLineState(0, { started: -1, sung: false })).toBe("upcoming");
    expect([0, 1].map((index) => lyricLineState(index, { started: 0, sung: false }))).toStrictEqual(
      ["past", "upcoming"],
    );
  });
});
