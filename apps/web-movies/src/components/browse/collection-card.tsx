import type { Collection } from "@/lib/catalog";
import { PosterCard } from "@media/ui/components/media-card";
import { Link } from "@tanstack/react-router";

import { artworkUrl } from "@/lib/artwork";
import { plural } from "@/lib/format";

const posterOf = (collection: Collection): string | null =>
  collection.artwork.poster ??
  collection.titles.find((title) => title.artwork.poster !== null)?.artwork.poster ??
  null;

/** A 2:3 card for a collection, with how many titles it holds. */
export function CollectionCard({
  collection,
  className,
}: {
  readonly collection: Collection;
  readonly className?: string;
}) {
  return (
    <PosterCard
      title={collection.name}
      subtitle={plural(collection.titles.length, "title", "titles")}
      image={artworkUrl(posterOf(collection), "poster")}
      className={className}
      render={<Link to="/collection/$collectionId" params={{ collectionId: collection.id }} />}
    />
  );
}
