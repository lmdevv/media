import { describe, expect, it } from "vitest";

import { albumMeta } from "./album-meta";
import { albumOf, trackOf } from "./test-fixtures";

const tracks = Array.from({ length: 9 }, (_, index) => trackOf(`Song ${String(index)}`));

describe("albumMeta", () => {
  it("reads like Paper's line, in caps", () => {
    expect(
      albumMeta({ album: albumOf("Blue Lines"), genre: "Trip-hop", durationMs: 2_700_000, tracks }),
    ).toBe("1991 · TRIP-HOP · 9 SONGS · 45 MIN");
  });

  it("leaves out an unknown year or genre, and never says 0 min", () => {
    expect(
      albumMeta({
        album: albumOf("Demo", "Me", null),
        genre: null,
        durationMs: 20_000,
        tracks: tracks.slice(0, 1),
      }),
    ).toBe("1 SONG · 1 MIN");
  });
});
