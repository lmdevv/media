import type { SessionEntry } from "@media/player/session-react";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { frontOf, parseJamLink, upcomingInJam } from "./jam";

const LINK = "mt_k57abc123.Sx9-_ZtqLmno0pQrStUvWxYz";

describe("parseJamLink", () => {
  it("reads the link itself, and the web address the Jam panel copies", () => {
    expect(parseJamLink(LINK)).toBe(LINK);
    expect(parseJamLink(`  ${LINK}\n`)).toBe(LINK);
    expect(parseJamLink(`https://music.home.test/music/jam#${LINK}`)).toBe(LINK);
    expect(parseJamLink(`http://192.168.1.4:8080/music/jam#${encodeURIComponent(LINK)}`)).toBe(
      LINK,
    );
  });

  it("refuses text that holds no Jam link", () => {
    expect(parseJamLink("")).toBe(null);
    expect(parseJamLink("https://music.home.test/music/albums")).toBe(null);
    expect(parseJamLink("mt_onlyhalf")).toBe(null);
    expect(parseJamLink("%E0%A4%A")).toBe(null);
  });
});

type Song = NonNullable<SessionEntry["track"]>;

const entryId = Brand.nominal<SessionEntry["key"]>();

const song: Song = {
  id: Brand.nominal<Song["id"]>()("t1"),
  title: "First Tone",
  artist: "E2E Ensemble",
  artistId: Brand.nominal<Song["artistId"]>()("a1"),
  album: "Fixture Tones",
  albumId: Brand.nominal<Song["albumId"]>()("b1"),
  trackNumber: 1,
  discNumber: null,
  durationMs: 6_000,
  codec: "FLAC",
  lossless: true,
  bitrate: null,
  sampleRate: 44_100,
  bitDepth: 16,
  artUrl: null,
  liked: false,
};

const entry = (key: string, fields: Partial<SessionEntry> = {}): SessionEntry => ({
  key: entryId(key),
  track: null,
  hidden: false,
  addedBy: "aiko",
  removable: false,
  ...fields,
});

describe("upcomingInJam", () => {
  it("leaves out the entry the player moved on to, and entries whose song still loads", () => {
    const entries = [
      entry("e1", { track: song }),
      entry("e2", { track: song }),
      entry("e3"),
      entry("e4", { hidden: true }),
    ];

    expect(upcomingInJam(entries, "e1").map((shown) => shown.key)).toEqual(["e2", "e4"]);
    expect(upcomingInJam(entries, "start:s").map((shown) => shown.key)).toEqual(["e1", "e2", "e4"]);
  });
});

describe("frontOf", () => {
  it("puts a move to the top after what the queue holds before the first entry shown", () => {
    const entries = [entry("e1", { track: song }), entry("e2"), entry("e3", { track: song })];

    expect(frontOf(entries, entryId("e3"))).toBe("e2");
    expect(frontOf(entries, entryId("e1"))).toBe(null);
    expect(frontOf(entries, null)).toBe(null);
  });
});
