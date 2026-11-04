import { commands } from "@media/contracts/commands";
import { describe, expect, it } from "vitest";

import { formatDuration, renderResult } from "./render";

const card = {
  id: "t1",
  kind: "movie",
  name: "Alien",
  year: 1979,
  certification: "R",
  ageRating: 17,
  runtimeMs: 7_020_000,
  genres: ["Horror"],
  artwork: { poster: null, backdrop: null, logo: null },
  available: true,
  addedAt: 1_760_000_000_000,
};

describe("human output", () => {
  it("formats durations", () => {
    expect(formatDuration(61_000)).toBe("1:01");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("renders lists of known models as tables", () => {
    const text = renderResult(commands["titles.search"].result, [card]);

    expect(text.split("\n")[0]).toMatch(/^ID\s+NAME\s+KIND\s+YEAR\s+RATING\s+RUNTIME$/u);
    expect(text).toContain("Alien");
    expect(text).toContain("1:57:00");
  });

  it("renders pages with the next cursor", () => {
    const text = renderResult(commands["titles.list"].result, { items: [card], nextCursor: "c2" });

    expect(text).toContain("More: --cursor c2");
  });

  it("renders acknowledgements as ok", () => {
    expect(renderResult(commands["rooms.leave"].result, { ok: true })).toBe("ok");
  });
});
