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
        owner: { id: "u1", name: "Lucía" },
        visibility: "shared",
        sharedWithPeople: true,
        access: "owner",
      },
      items: [
        {
          itemId: "i1",
          addedAt: Date.UTC(2026, 9, 10, 12, 0),
          track,
          durationMs: track.durationMs,
          available: true,
          reason: null,
          addedBy: { id: "u1", name: "Lucía" },
        },
        {
          itemId: "i2",
          addedAt: Date.UTC(2026, 9, 10, 12, 0),
          track: null,
          durationMs: 251_000,
          available: false,
          reason: "no_access",
          addedBy: null,
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
      "  owner:",
      "    id: u1",
      "    name: Lucía",
      "  visibility: shared",
      "  shared with people: yes",
      "  access: owner",
      "items:",
      "  ITEM  TRACK  TITLE                             ARTIST     TIME  ADDED BY  STATUS",
      "  i1    t1     Harder, Better, Faster, Stronger  Daft Punk  3:44  Lucía",
      "  i2    -      -                                 -          4:11  -         no access",
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

  it("writes out control characters instead of passing them to the terminal", () => {
    const hostile = { ...track, title: "\u001b[2JGone\u009b31m\u0007" };
    const table = renderResult(commands["likes.list"].result, [hostile]);

    const lines = renderResult(commands["account.me"].result, {
      id: "u1",
      email: "me@music.test",
      name: "\u001b]0;pwned\u0007",
      role: "member",
    });

    expect(table).toContain(String.raw`\u001b[2JGone\u009b31m\u0007`);
    expect(lines).toContain(String.raw`\u001b]0;pwned\u0007`);
    expect(/\p{Cc}/u.test(`${table}${lines}`.replaceAll("\n", ""))).toBe(false);
  });
});

describe("renderResult for lyrics", () => {
  const lyrics = commands["lyrics.get"].result;

  it("prints synced lyrics with their times under the player's caption, then the other sets", () => {
    const synced = {
      _tag: "Synced",
      source: "file",
      main: {
        kind: "main",
        lang: null,
        origin: { _tag: "Sidecar", fileName: "Song.lrc", format: "lrc" },
        body: {
          _tag: "Synced",
          lines: [
            { text: "First line", startMs: 1000, endMs: null, words: null, voice: null },
            { text: "Later \u001b[2J", startMs: 62_345, endMs: null, words: null, voice: null },
          ],
        },
      },
      extras: [
        {
          kind: "translation",
          lang: "de",
          origin: { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" },
          body: { _tag: "Plain", text: "Erste Zeile" },
        },
      ],
    };

    expect(renderResult(lyrics, synced).split("\n")).toEqual([
      "SYNCED LYRICS · FROM FILE (Song.lrc)",
      "",
      "[00:01.00] First line",
      String.raw`[01:02.34] Later \u001b[2J`,
      "",
      "Also:",
      "  translation (de) from Song.de.lrc",
    ]);
  });

  it("prints each row of a multi-row subtitle cue on its own line, under the cue's time", () => {
    const cue = {
      _tag: "Synced",
      source: "file",
      main: {
        kind: "main",
        lang: null,
        origin: { _tag: "Sidecar", fileName: "Song.vtt", format: "vtt" },
        body: {
          _tag: "Synced",
          lines: [
            { text: "Top row\nBottom row", startMs: 1000, endMs: 3000, words: null, voice: null },
          ],
        },
      },
      extras: [],
    };

    expect(renderResult(lyrics, cue).split("\n")).toEqual([
      "SYNCED LYRICS · FROM FILE (Song.vtt)",
      "",
      "[00:01.00] Top row",
      "           Bottom row",
    ]);
  });

  it("prints plain lyrics as their text, and says when there are none", () => {
    const plain = {
      _tag: "Plain",
      source: "file",
      main: {
        kind: "main",
        lang: "en",
        origin: { _tag: "Embedded", tag: "mp4:lyr" },
        body: { _tag: "Plain", text: "Just words\nMore words" },
      },
      extras: [],
    };

    expect(renderResult(lyrics, plain).split("\n")).toEqual([
      "LYRICS · FROM FILE (mp4:lyr tag)",
      "",
      "Just words",
      "More words",
    ]);
    expect(renderResult(lyrics, { _tag: "None" })).toBe("No lyrics");
    expect(renderResult(lyrics, { _tag: "Instrumental" })).toBe("Instrumental");
  });

  it("fails loudly for a value that is not lyrics instead of printing it as something else", () => {
    expect(() => renderResult(lyrics, { _tag: "Synced", source: "file" })).toThrow();
  });
});
