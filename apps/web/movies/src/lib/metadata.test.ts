import { describe, expect, it } from "vitest";

import {
  creditRole,
  decadesUntil,
  formatDate,
  languageName,
  personLinks,
  personRole,
  scoresOf,
  titleLinks,
  trailerEmbedUrl,
  yearsBetween,
} from "./metadata";

describe("metadata display", () => {
  it("lists scores IMDb first and leaves out sites without one", () => {
    expect(
      scoresOf({
        tmdb: { value: 7.06, votes: 900 },
        imdb: { value: 7.9, votes: 1000 },
        rottenTomatoes: 88,
        metacritic: null,
      }).map((score) => `${score.mark} ${score.value}`),
    ).toStrictEqual(["IMDb 7.9", "RT 88%", "TMDB 7.1"]);
  });

  it("links only well-formed provider IDs", () => {
    expect(
      titleLinks("show", { tmdb: "95396", imdb: "tt11280740", tvdb: "371980" }).map(
        (link) => link.href,
      ),
    ).toStrictEqual([
      "https://www.imdb.com/title/tt11280740/",
      "https://www.themoviedb.org/tv/95396",
      "https://thetvdb.com/dereferrer/series/371980",
    ]);
    expect(titleLinks("movie", { tmdb: "../x", imdb: "nm1", tvdb: null })).toStrictEqual([]);
    expect(
      personLinks({ tmdb: "10205", imdb: "nm0000244", tvdb: null }).map((l) => l.label),
    ).toStrictEqual(["IMDb", "TMDB"]);
  });

  it("says what a person did", () => {
    expect(creditRole({ kind: "actor", role: "Ripley", episodeCount: 0 })).toBe("Ripley");
    expect(creditRole({ kind: "director", role: null, episodeCount: 0 })).toBe("Director");
    expect(creditRole({ kind: "guest-star", role: null, episodeCount: 3 })).toBe(
      "Guest star · 3 episodes",
    );
  });

  it("names the character under a title on a person's page", () => {
    expect(personRole({ kind: "actor", role: "Ripley", episodeCount: 0 })).toBe("as Ripley");
    expect(personRole({ kind: "guest-star", role: "Visitor", episodeCount: 2 })).toBe(
      "as Visitor · 2 episodes",
    );
    expect(personRole({ kind: "actor", role: null, episodeCount: 0 })).toBe("Cast");
    expect(personRole({ kind: "director", role: "Director", episodeCount: 0 })).toBe("Director");
  });

  it("formats dates, ages, and languages", () => {
    expect(formatDate("1999-03-31")).toBe("March 31, 1999");
    expect(formatDate("1999")).toBe("1999");
    expect(yearsBetween("1949-10-08", "2024-10-07")).toBe(74);
    expect(yearsBetween("1949-10-08", "2024-10-08")).toBe(75);
    expect(languageName("en")).toBe("English");
    expect(languageName("not a code")).toBe("not a code");
  });

  it("embeds only well-formed YouTube keys, from the cookieless player", () => {
    expect(trailerEmbedUrl("dQw4w9WgXcQ")).toMatch(
      /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/u,
    );
    expect(trailerEmbedUrl('x"><script>')).toBeUndefined();
  });

  it("offers decades back to the 1920s", () => {
    const decades = decadesUntil(2026);

    expect(decades[0]).toStrictEqual({ label: "2020s", from: 2020, to: 2029 });
    expect(decades.at(-1)?.label).toBe("1920s");
  });
});
