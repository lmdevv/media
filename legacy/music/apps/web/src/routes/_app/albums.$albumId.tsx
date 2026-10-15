import { AlbumId, TrackId } from "@music/commands/ids";
import { useRead } from "@music/sdk/react";
import { Badge } from "@music/ui/components/badge";
import { Skeleton } from "@music/ui/components/skeleton";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Schema } from "effect";

import { DetailError } from "@/components/route-error";
import type { MissingCopy } from "@/components/route-error";
import { Artwork } from "@/components/library/artwork";
import { CollectionHeader } from "@/components/library/collection-header";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { formatTotal, plural } from "@/lib/format";

const decodeAlbumId = Schema.decodeUnknownSync(AlbumId);

const MISSING: MissingCopy = {
  title: "This album isn't in your library anymore",
  description:
    "A rescan may have removed it, its folder was removed from [music], it's in a library that isn't shared with you, or the link is wrong.",
  back: { to: "/albums", label: "Back to albums" },
};

/** `?track=` highlights a song: shared song links open its album this way. */
const AlbumSearch = Schema.Struct({ track: Schema.optionalKey(TrackId) });

export const Route = createFileRoute("/_app/albums/$albumId")({
  params: {
    parse: (params) => ({ albumId: decodeAlbumId(params.albumId) }),
    stringify: (params) => ({ albumId: params.albumId }),
  },
  validateSearch: Schema.toStandardSchemaV1(AlbumSearch),
  component: AlbumPage,
  errorComponent: AlbumError,
});

function AlbumPage() {
  const { albumId } = Route.useParams();
  const { track: highlight } = Route.useSearch();
  const detail = useRead("albums.get", { albumId });

  if (detail === undefined) {
    return (
      <div className="flex flex-col gap-8 px-5 pt-row lg:px-12">
        <div className="flex items-end gap-8">
          <Skeleton className="size-58 rounded-md" />
          <div className="flex grow flex-col gap-3">
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-12 w-96 max-w-full" />
          </div>
        </div>
        <TrackListSkeleton />
      </div>
    );
  }

  const { album, tracks } = detail;
  const lossless = tracks.length > 0 && tracks.every((track) => track.lossless);

  const meta = [
    "Album",
    album.year === null ? null : String(album.year),
    plural(album.trackCount, "song"),
    formatTotal(detail.durationMs),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const artistLink = (
    <Link to="/artists/$artistId" params={{ artistId: album.artistId }} className="hover:underline">
      {album.artist}
    </Link>
  );

  return (
    <div className="flex flex-col gap-8 px-5 pt-safe-top-sm lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={
          <Artwork url={album.artUrl} seed={album.id} className="size-58 rounded-md shadow-cover" />
        }
        phoneCover={
          <Artwork
            url={album.artUrl}
            seed={album.id}
            className="size-67.5 rounded-lg shadow-cover-phone"
          />
        }
        eyebrow={meta}
        title={album.title}
        subtitle={artistLink}
        phoneMeta={[
          detail.genre,
          album.year === null ? null : String(album.year),
          lossless ? "Lossless" : detail.format,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        badge={<Badge tone="outline">{detail.format}</Badge>}
        tracks={tracks}
        link={{ kind: "album", id: album.id }}
      />
      <div className="-mx-5 pl-5 lg:mx-0 lg:pl-0">
        <TrackList
          tracks={tracks}
          variant="album"
          label={`Songs on ${album.title}`}
          highlight={highlight ?? null}
        />
      </div>
    </div>
  );
}

function AlbumError(props: ErrorComponentProps) {
  return <DetailError {...props} copy={MISSING} />;
}
