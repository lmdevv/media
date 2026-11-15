import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { EpisodeId, TitleId } from "@/lib/catalog";

import { itemKey, itemOf, parseSessionLink, sessionUrl } from "./session";

const LINK = "mt_k57abc123.AbCdEf_-0123456789abcdefgh";

describe("parseSessionLink", () => {
  it("reads a link, a web address, or this app's address that ends in one", () => {
    expect(parseSessionLink(LINK)).toBe(LINK);
    expect(parseSessionLink(`https://cinema.home/movies/together#${LINK}`)).toBe(LINK);
    expect(parseSessionLink(`movies://together/${encodeURIComponent(LINK)}`)).toBe(LINK);
  });

  it("reads nothing from other text", () => {
    expect(parseSessionLink("movies://title/k57")).toBeNull();
  });
});

describe("sessionUrl", () => {
  it("opens the link in the web app beside the server", () => {
    expect(sessionUrl("http://cinema.home:8080/movies/", LINK)).toBe(
      `http://cinema.home:8080/movies/together#${LINK}`,
    );
  });
});

describe("itemOf", () => {
  it("names a show's episode, and a movie as its title", () => {
    const show = Brand.nominal<TitleId>()("show");
    const episode = Brand.nominal<EpisodeId>()("ep");

    expect(itemKey(itemOf({ titleId: show, episodeId: episode }))).toBe("movies:episode:ep");
    expect(itemKey(itemOf({ titleId: show, episodeId: null }))).toBe("movies:title:show");
  });
});
