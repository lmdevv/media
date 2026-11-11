import { Option } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { asEpisodeId, asMediaFileId, asTitleId } from "./catalog";
import { downloadHref, parseWatchParams, playDownloadHref, watchHref } from "./routes";

const titleId = asTitleId;

const episodeId = asEpisodeId;

const fileId = asMediaFileId;

const routeParams = (href: string) => {
  const [path = "", query = ""] = href.split("?");
  const params = new Map([["titleId", decodeURIComponent(path.replace(/^\/watch\//u, ""))]]);

  for (const pair of query === "" ? [] : query.split("&")) {
    const [key = "", value = ""] = pair.split("=");

    params.set(key, decodeURIComponent(value));
  }

  return Object.fromEntries(params);
};

describe("watchHref", () => {
  it("plays a movie from its saved position with no query", () => {
    expect(watchHref({ titleId: titleId("t1") })).toBe("/watch/t1");
  });

  it("names the episode, the version, and Start Over in a fixed order", () => {
    expect(
      watchHref({
        titleId: titleId("t1"),
        episodeId: episodeId("e2"),
        fileId: fileId("f3"),
        start: "beginning",
      }),
    ).toBe("/watch/t1?episodeId=e2&fileId=f3&start=beginning");

    expect(watchHref({ titleId: titleId("t1"), fileId: fileId("f3") })).toBe("/watch/t1?fileId=f3");

    expect(watchHref({ titleId: titleId("t1"), episodeId: episodeId("e2") })).toBe(
      "/watch/t1?episodeId=e2",
    );

    expect(watchHref({ titleId: titleId("t1"), at: 5_598_000.4 })).toBe("/watch/t1?at=5598000");

    expect(watchHref({ titleId: titleId("t1"), episodeId: undefined, start: "beginning" })).toBe(
      "/watch/t1?start=beginning",
    );
  });

  it("reads back through URLSearchParams whatever the IDs contain", () => {
    // Dot segments are not IDs; URL parsing would resolve them away.
    const id = fc.string({ minLength: 1 }).filter((value) => value !== "." && value !== "..");

    fc.assert(
      fc.property(
        id,
        fc.option(id, { nil: undefined }),
        fc.option(id, { nil: undefined }),
        fc.constantFrom(undefined, "beginning" as const, "resume" as const),
        fc.option(fc.nat(), { nil: undefined }),
        (title, episode, file, start, at) => {
          const href = watchHref({
            titleId: titleId(title),
            episodeId: episode === undefined ? undefined : episodeId(episode),
            fileId: file === undefined ? undefined : fileId(file),
            start,
            at,
          });

          const url = new URL(href, "movies://app");
          const query = new URLSearchParams(url.search);

          expect(decodeURIComponent(url.pathname)).toBe(`/watch/${title}`);
          expect(query.get("episodeId") ?? undefined).toBe(episode);
          expect(query.get("fileId") ?? undefined).toBe(file);
          expect(query.get("start") ?? undefined).toBe(start);

          const parsed = Option.getOrThrow(parseWatchParams(routeParams(href)));

          expect(parsed.titleId).toBe(title);
          expect(parsed.episodeId).toBe(episode);
          expect(parsed.fileId).toBe(file);
          expect(parsed.start).toBe(start);
          expect(parsed.at).toBe(at);
        },
      ),
    );
  });
});

describe("download links", () => {
  it("plays a kept download through the player, and opens its page", () => {
    const href = playDownloadHref({
      id: "p1-t1-e2",
      titleId: titleId("t1"),
      episodeId: episodeId("e2"),
    });

    expect(href).toBe("/watch/t1?episodeId=e2&download=p1-t1-e2");
    expect(parseWatchParams(routeParams(href))).toStrictEqual(
      Option.some({ titleId: "t1", episodeId: "e2", download: "p1-t1-e2" }),
    );
    expect(downloadHref("p1-t1-movie")).toBe("/download/p1-t1-movie");
  });
});

describe("parseWatchParams", () => {
  it("reads the first of a repeated key", () => {
    const parsed = parseWatchParams({ titleId: "t", episodeId: ["e1", "e2"] });

    expect(Option.map(parsed, (params) => params.episodeId)).toStrictEqual(Option.some("e1"));
  });

  it("rejects a missing title, an unknown start, and a position that is not one", () => {
    expect(Option.isNone(parseWatchParams({ episodeId: "e" }))).toBe(true);
    expect(Option.isNone(parseWatchParams({ titleId: "t", start: "middle" }))).toBe(true);
    expect(Option.isNone(parseWatchParams({ titleId: "t", at: "soon" }))).toBe(true);
    expect(Option.isNone(parseWatchParams({ titleId: "t", at: "-5" }))).toBe(true);
  });

  it("treats empty values as absent", () => {
    const parsed = parseWatchParams({ titleId: "t", fileId: "", start: "" });

    expect(parsed).toStrictEqual(Option.some({ titleId: "t" }));
  });
});
