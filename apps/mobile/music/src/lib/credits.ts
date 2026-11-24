/**
 * How the app shows the artists a song or an album credits, by the rule in
 * `@media/contracts/artist-credits`: one line of text where a tap plays or opens something else,
 * and the artists a control that opens an artist offers.
 */
import { creditLine, creditsOf } from "@media/contracts/artist-credits";
import type { CreditedItem, ShownCredit } from "@media/contracts/artist-credits";

import type { ArtistId } from "./models";

/** What a line of text needs of a song or an album: its artist as tagged, and its credits. */
export type CreditText = Pick<CreditedItem<ArtistId>, "artist" | "credits">;

/**
 * The artists `item` credits as one line of text, joined the way its tags write them ("Mora &
 * JHAYCO"), with each credit the tags' artist doesn't name, such as a featured artist, after it.
 * Without credits it is the artist as tagged. The first credit is the item's `artistId`, so the
 * line needs nothing else.
 */
export const creditText = (item: CreditText): string => {
  const { artist, credits } = item;
  const first = credits?.[0];

  if (credits === undefined || first === undefined) return artist;

  return creditLine({ artist, artistId: first.artistId, credits })
    .map((piece) => (piece.kind === "text" ? piece.text : piece.name))
    .join("");
};

/**
 * The artists a control that opens an artist offers for `item`, in the order its line shows them
 * and spelled as it shows them, each once. There is always at least one.
 */
export const creditArtists = (
  item: CreditedItem<ArtistId>,
): ReadonlyArray<ShownCredit<ArtistId>> => {
  const seen = new Set<ArtistId>();

  return creditLine(item).flatMap((piece) => {
    if (piece.kind !== "artist" || seen.has(piece.artistId)) return [];

    seen.add(piece.artistId);

    return [{ artistId: piece.artistId, name: piece.name }];
  });
};

/** Whether `item` credits anyone besides `artistId`, as a song an artist shares or features on. */
export const creditsOthers = (item: CreditedItem<ArtistId>, artistId: ArtistId): boolean =>
  creditsOf(item).some((credit) => credit.artistId !== artistId);
