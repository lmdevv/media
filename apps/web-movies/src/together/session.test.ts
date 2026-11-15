import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { EpisodeId, TitleId } from "@/lib/catalog";

import { itemOf, namesTarget, parseSessionLink } from "./session";

const brand = <B extends Brand.Brand<string>>() => Brand.nominal<B>();

const LINK = "mt_k57abc123.AbCdEf_-0123456789abcdefgh";

describe("parseSessionLink", () => {
  it("reads a link, or a web address that ends in one", () => {
    expect(parseSessionLink(LINK)).toBe(LINK);
    expect(parseSessionLink(`  https://cinema.home/movies/together#${LINK} `)).toBe(LINK);
    expect(
      parseSessionLink(`https://cinema.home/movies/together/${encodeURIComponent(LINK)}`),
    ).toBe(LINK);
  });

  it("reads nothing from other text", () => {
    expect(parseSessionLink("Sintel")).toBeNull();
    expect(parseSessionLink("https://cinema.home/movies/title/k57")).toBeNull();
  });
});

describe("itemOf", () => {
  it("names a show's episode, and a movie as its title", () => {
    const show = { titleId: brand<TitleId>()("show"), episodeId: brand<EpisodeId>()("ep") };
    const movie = { titleId: brand<TitleId>()("movie"), episodeId: null };

    expect(itemOf(show)).toStrictEqual({ domain: "movies", ref: { type: "episode", id: "ep" } });
    expect(itemOf(movie)).toStrictEqual({ domain: "movies", ref: { type: "title", id: "movie" } });
    expect(namesTarget(itemOf(show), show)).toBe(true);
    expect(namesTarget(itemOf(show), movie)).toBe(false);
  });
});
