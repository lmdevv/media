import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { MediaVersion, TitleCard } from "@media/contracts/models/catalog";

import { bestTitle, pickVersion } from "./watch-commands";

const card = (id: string, name: string) =>
  Schema.decodeSync(TitleCard)({
    id,
    kind: "movie",
    name,
    year: null,
    certification: null,
    ageRating: null,
    runtimeMs: null,
    genres: [],
    artwork: { poster: null, backdrop: null, logo: null },
    available: true,
    addedAt: 0,
  });

describe("choosing what to play", () => {
  const results = [card("a", "Aliens"), card("b", "Alien"), card("c", "Alien: Romulus")];

  const chosen = (query: string, from = results) =>
    Option.getOrNull(Option.map(bestTitle(query, from), (title) => title.id));

  it("prefers an exact name, ignoring case and punctuation", () => {
    expect(chosen("ALIEN")).toBe("b");
    expect(chosen("alien romulus")).toBe("c");
  });

  it("falls back to a name starting with the query, then the first result", () => {
    expect(chosen("alien rom")).toBe("c");
    expect(chosen("xenomorph")).toBe("a");
    expect(chosen("anything", [])).toBeNull();
  });
});

const version = (id: string, versionName: string | null, height: number | null) =>
  Schema.decodeSync(MediaVersion)({
    id,
    versionName,
    width: height === null ? null : Math.round((height * 16) / 9),
    height,
    hdr: "none",
    videoCodec: height === null ? null : "hevc",
    videoProfile: null,
    videoLevel: null,
    videoBitDepth: null,
    audioCodec: "aac",
    audioChannels: 2,
    audioTracks: 1,
    container: "mkv",
    sizeBytes: 1_000,
    durationMs: 60_000,
    lastPlayed: false,
  });

describe("choosing a version", () => {
  const versions = [
    version("dc", "Director's Cut", 2160),
    version("theatrical", "Theatrical", 1080),
    version("plain", null, 720),
  ];

  const picked = (choice: string) =>
    Option.getOrNull(Option.map(pickVersion(choice, versions), (found) => found.id));

  it("takes a number counted from 1 in the listed order", () => {
    expect(picked("1")).toBe("dc");
    expect(picked("3")).toBe("plain");
    expect(picked("0")).toBeNull();
    expect(picked("4")).toBeNull();
  });

  it("takes a name ignoring case and punctuation, exactly or by its start", () => {
    expect(picked("directors cut")).toBe("dc");
    expect(picked("THEAT")).toBe("theatrical");
    expect(picked("extended")).toBeNull();
    expect(picked("!!")).toBeNull();
  });
});
