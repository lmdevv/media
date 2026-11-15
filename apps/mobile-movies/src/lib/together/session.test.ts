import type { SessionClock } from "@media/contracts/clock";
import { Brand, Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { EpisodeId, TitleId } from "@/lib/catalog";

import { NO_HOLD, holdsSession, itemKey, itemOf, parseSessionLink, sessionUrl } from "./session";
import type { CarriedHold } from "./session";

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

const pausedAt = (revision: number): SessionClock => ({
  status: "paused",
  positionAtAnchorMs: 30_000,
  anchorServerTime: 0,
  playbackRate: 1,
  revision,
});

describe("holdsSession", () => {
  const held: CarriedHold = { sessionId: "s1", hold: { kind: "held", revision: 6 } };

  it("holds its own session while its pause is on its way, or while the hold stands", () => {
    const pausing: CarriedHold = {
      sessionId: "s1",
      hold: { kind: "pausing", landed: Effect.succeed(null) },
    };

    expect(holdsSession(pausing, "s1", pausedAt(4))).toBe(true);
    expect(holdsSession(held, "s1", pausedAt(6))).toBe(true);
  });

  it("holds nothing once someone moved the session, in another session, or with no hold", () => {
    expect(holdsSession(held, "s1", pausedAt(7))).toBe(false);
    expect(holdsSession(held, "s1", { ...pausedAt(6), status: "playing" })).toBe(false);
    expect(holdsSession(held, "s2", pausedAt(6))).toBe(false);
    expect(holdsSession(NO_HOLD, "s1", pausedAt(6))).toBe(false);
  });
});
