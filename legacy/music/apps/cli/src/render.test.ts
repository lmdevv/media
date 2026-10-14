import type { Track } from "@music/commands/models";
import { commands } from "@music/commands/registry";
import { assert, integer, property } from "fast-check";
import { describe, expect, it } from "vitest";

import { formatDuration, formatTimestamp, renderResult } from "./render";

const track = {
  id: "t1",
  title: "Harder, Better, Faster, Stronger",
  artist: "Daft Punk",
  artistId: "ar1",
  album: "Discovery",
  albumId: "al1",
  trackNumber: 4,
  discNumber: 1,
  durationMs: 224_000,
  codec: "flac",
  lossless: true,
  bitrate: null,
  sampleRate: 44_100,
  bitDepth: 16,
  artUrl: null,
  liked: true,
} satisfies (typeof Track)["Encoded"];

describe("formatDuration", () => {
  it("uses m:ss under an hour and h:mm:ss above", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(61_000)).toBe("1:01");
    expect(formatDuration(224_999)).toBe("3:44");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("round-trips to whole seconds", () => {
    assert(
      property(integer({ min: 0, max: 100 * 3_600_000 }), (ms) => {
        const seconds = formatDuration(ms)
          .split(":")
          .reduce((total, part) => total * 60 + Number(part), 0);

        expect(seconds).toBe(Math.floor(ms / 1000));
      }),
    );
  });
});

describe("renderResult", () => {
  it("renders track lists as a table", () => {
    expect(renderResult(commands["likes.list"].result, [track]).split("\n")).toEqual([
      "ID  TITLE                             ARTIST     ALBUM      TIME  LIKED",
      "t1  Harder, Better, Faster, Stronger  Daft Punk  Discovery  3:44  ♥",
    ]);
  });

  it("renders objects as key-value lines with nested tables", () => {
    const playlist = {
      playlist: {
        id: "p1",
        name: "Road trip",
        description: null,
        trackCount: 1,
        durationMs: 224_000,
        artUrls: [],
        updatedAt: Date.UTC(2026, 9, 10, 12, 0),
      },
      items: [
        { itemId: "i1", addedAt: Date.UTC(2026, 9, 10, 12, 0), track, available: true },
        {
          itemId: "i2",
          addedAt: Date.UTC(2026, 9, 10, 12, 0),
          track: { ...track, id: "t2", title: "Gone" },
          available: false,
        },
      ],
    } satisfies (typeof commands)["playlists.get"]["result"]["Encoded"];

    expect(renderResult(commands["playlists.get"].result, playlist).split("\n")).toEqual([
      "playlist:",
      "  id: p1",
      "  name: Road trip",
      "  description: -",
      "  track count: 1",
      "  duration: 3:44",
      "  art urls: (none)",
      `  updated at: ${formatTimestamp(playlist.playlist.updatedAt)}`,
      "items:",
      "  ITEM  TRACK  TITLE                             ARTIST     TIME  STATUS",
      "  i1    t1     Harder, Better, Faster, Stronger  Daft Punk  3:44",
      "  i2    t2     Gone                              Daft Punk  3:44  unavailable",
    ]);
  });

  it("renders the account and empty results", () => {
    expect(
      renderResult(commands["account.me"].result, {
        id: "u1",
        email: "me@example.com",
        name: null,
        role: "admin",
      }),
    ).toBe(["id: u1", "email: me@example.com", "name: -", "role: admin"].join("\n"));
    expect(renderResult(commands["playlists.list"].result, [])).toBe("(none)");
    expect(renderResult(commands["playback.pause"].result, { ok: true })).toBe("ok");
  });

  it("renders cursor pages as a table with the next cursor", () => {
    const album = {
      id: "al1",
      title: "Discovery",
      artist: "Daft Punk",
      artistId: "ar1",
      year: 2001,
      artUrl: null,
      trackCount: 14,
    };

    expect(
      renderResult(commands["albums.list"].result, { items: [album], cursor: "c2", done: false }),
    ).toBe(
      [
        "ID   TITLE      ARTIST     YEAR  SONGS",
        "al1  Discovery  Daft Punk  2001  14",
        "More: --cursor c2",
      ].join("\n"),
    );
    expect(
      renderResult(commands["albums.list"].result, { items: [album], cursor: "", done: true }),
    ).not.toContain("More:");
  });

  it("truncates long cells", () => {
    const long = { ...track, title: "x".repeat(80) };
    const [, row] = renderResult(commands["likes.list"].result, [long]).split("\n");

    expect(row).toContain(`${"x".repeat(47)}…`);
  });
});
