import { creditLine } from "@media/contracts/artist-credits";
import type { CreditedItem } from "@media/contracts/artist-credits";
import { Link } from "@tanstack/react-router";

import type { ArtistId } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * The artists a song or an album credits as one line of text: their names, joined the way its
 * tags write them ("Mora & JHAYCO"). For a label, a toast, or a place that can't hold links.
 */
export const creditText = (item: CreditedItem<ArtistId>): string =>
  creditLine(item)
    .map((piece) => (piece.kind === "text" ? piece.text : piece.name))
    .join("");

/**
 * A song's or an album's artists, each a link to that artist's page, joined the way its tags
 * write them. It renders only text and links, so the caller's element sets the type, colour, and
 * truncation, and the line reads as one string in a row. A pointer click on a link leaves nothing
 * focused (the focus policy); a keyboard focus shows its ring and underlines the name, so a ring
 * that a truncating row clips still shows.
 */
export function ArtistCredits({
  item,
  links = true,
  linkClassName,
}: {
  readonly item: CreditedItem<ArtistId>;
  /**
   * False where the line can't hold links: inside another link or button, or for a guest, who
   * can't open artist pages. The names then show as plain text.
   */
  readonly links?: boolean;
  /** Extra classes for each link, such as `relative` to raise it over a card's stretched link. */
  readonly linkClassName?: string;
}) {
  if (!links) return creditText(item);

  // The joins are bare strings, which need no key; a line credits each artist once.
  return creditLine(item).map((piece) =>
    piece.kind === "text" ? (
      piece.text
    ) : (
      <Link
        key={piece.artistId}
        to="/artists/$artistId"
        params={{ artistId: piece.artistId }}
        // A drag that starts on a name moves the row it is in, as in a queue or a playlist.
        draggable={false}
        className={cn(
          "rounded-xs hover:text-text hover:underline focus-visible:text-text focus-visible:underline",
          linkClassName,
        )}
      >
        {piece.name}
      </Link>
    ),
  );
}
