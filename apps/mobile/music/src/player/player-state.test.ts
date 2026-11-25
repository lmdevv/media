import { describe, expect, it } from "vitest";

import { creditText } from "@/lib/credits";
import { asArtistId } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import { nowPlayingOf, queueItemOf, sameSong } from "./player-state";

const mora = asArtistId("ar-Mora");

const featured = {
  ...trackOf("TOA (feat. Young Miko)", "Mora"),
  artistId: mora,
  credits: [
    { artistId: mora, name: "Mora" },
    { artistId: asArtistId("ar-Young Miko"), name: "Young Miko" },
  ],
};

const entryOf = (track: typeof featured | ReturnType<typeof trackOf>) => ({
  itemId: `item-${track.id}`,
  autoplay: false,
  track,
});

const art = () => null;

describe("nowPlayingOf", () => {
  it("carries every artist the song credits, and none for a song without credits", () => {
    expect(nowPlayingOf(entryOf(featured), art).credits).toEqual(featured.credits);
    expect(nowPlayingOf(entryOf(trackOf("Angel")), art)).not.toHaveProperty("credits");
  });

  it("reads the same for the same song", () => {
    expect(
      sameSong(nowPlayingOf(entryOf(featured), art), nowPlayingOf(entryOf(featured), art)),
    ).toBe(true);
  });
});

describe("queueItemOf", () => {
  it("shows the song's artists as one line", () => {
    expect(queueItemOf(entryOf(featured), art).artist).toBe(creditText(featured));
    expect(queueItemOf(entryOf(trackOf("Angel")), art).artist).toBe("Massive Attack");
  });
});
