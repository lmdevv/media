import type { SearchResults } from "@music/commands/models";
import { describe, expect, it } from "vitest";

import { foundNothing, searchRows, topResult } from "./search-results";
import type { SearchRow } from "./search-results";
import { albumOf, artistOf, trackOf } from "./test-fixtures";

const massive: SearchResults = {
  tracks: ["Unfinished Sympathy", "Teardrop", "Angel", "Safe from Harm", "Karmacoma"].map((title) =>
    trackOf(title),
  ),
  albums: [albumOf("Blue Lines"), albumOf("Mezzanine")],
  artists: [artistOf("Massive Attack", 6)],
};

/** What a row shows, as one line. */
const lineOf = (row: SearchRow): string => {
  if (row.kind === "section") return `# ${row.title}${row.more === null ? "" : " (See all)"}`;

  if (row.kind === "top") return `top ${row.top.kind}`;

  if (row.kind === "track") return `song ${row.track.title}`;

  if (row.kind === "album") return `album ${row.album.title}`;

  return `artist ${row.artist.name}`;
};

const summary = (rows: ReadonlyArray<SearchRow>): ReadonlyArray<string> => rows.map(lineOf);

describe("topResult", () => {
  it("prefers an artist whose name starts with the query, ignoring case and accents", () => {
    expect(topResult(massive, "MASSIVE")?.kind).toBe("artist");
    const bjork = { tracks: massive.tracks, albums: massive.albums, artists: [artistOf("Björk")] };

    expect(topResult(bjork, "bjork")?.kind).toBe("artist");
  });

  it("falls back to an album, then a song, whose title starts with the query", () => {
    expect(topResult(massive, "mezz")).toMatchObject({
      kind: "album",
      album: { title: "Mezzanine" },
    });
    expect(topResult(massive, "tear")).toMatchObject({ kind: "track", index: 1 });
  });

  it("takes the first song when nothing starts with the query", () => {
    expect(topResult(massive, "sympathy")).toMatchObject({ kind: "track", index: 0 });
    expect(topResult({ tracks: [], albums: [], artists: [] }, "x")).toBeNull();
  });
});

describe("searchRows", () => {
  it("leads All with the top result and caps each section with See all", () => {
    expect(summary(searchRows(massive, "all", "massive"))).toEqual([
      "# Top result",
      "top artist",
      "# Songs (See all)",
      "song Unfinished Sympathy",
      "song Teardrop",
      "song Angel",
      "song Safe from Harm",
      "# Albums",
      "album Blue Lines",
      "album Mezzanine",
    ]);
  });

  it("doesn't list the top result twice", () => {
    const rows = summary(searchRows(massive, "all", "tear"));

    expect(rows.slice(0, 2)).toEqual(["# Top result", "top track"]);
    expect(rows).not.toContain("song Teardrop");
  });

  it("shows one kind in full under a chip, keeping each song's place in the results", () => {
    const songs = searchRows(massive, "songs", "massive");

    expect(songs).toHaveLength(5);
    expect(songs.map((row) => (row.kind === "track" ? row.index : -1))).toEqual([0, 1, 2, 3, 4]);
    expect(summary(searchRows(massive, "artists", "massive"))).toEqual(["artist Massive Attack"]);
  });
});

describe("foundNothing", () => {
  it("is true only when every kind is empty", () => {
    expect(foundNothing({ tracks: [], albums: [], artists: [] })).toBe(true);
    expect(foundNothing(massive)).toBe(false);
  });
});
