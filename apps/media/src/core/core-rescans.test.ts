import { assert, describe, it } from "@effect/vitest";

import { pathsToSend } from "./core-rescans.ts";

describe("CoreRescans.pathsToSend", () => {
  it("sends each changed path once, none inside another it sends", () => {
    assert.deepStrictEqual(
      pathsToSend("/media", [
        "/media/movies/Film (2020)/film.mkv",
        "/media/movies/Film (2020)",
        "/media/movies/Film (2020)/film.nfo",
        "/media/shows/Show/s01e01.mkv",
        "/media/shows/Show/s01e01.mkv",
      ]),
      ["/media/movies/Film (2020)", "/media/shows/Show/s01e01.mkv"],
    );
  });

  it("keeps a sibling whose name only starts like another path", () => {
    assert.deepStrictEqual(pathsToSend("/media", ["/media/movies", "/media/movies 2/a.mkv"]), [
      "/media/movies",
      "/media/movies 2/a.mkv",
    ]);
  });

  it("sends the root when a burst named nothing or too many paths", () => {
    assert.deepStrictEqual(pathsToSend("/media", []), ["/media"]);

    const many = Array.from({ length: 33 }, (_, index) => `/media/movies/${String(index)}.mkv`);

    assert.deepStrictEqual(pathsToSend("/media", many), ["/media"]);
    assert.lengthOf(pathsToSend("/media", many.slice(0, 32)), 32);
  });
});
