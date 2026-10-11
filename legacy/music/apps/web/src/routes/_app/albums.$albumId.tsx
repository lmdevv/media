import { AlbumId } from "@music/commands/ids";
import { useRead } from "@music/sdk/react";
import { Badge } from "@music/ui/components/badge";
import { Skeleton } from "@music/ui/components/skeleton";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { Artwork } from "@/components/library/artwork";
import { CollectionHeader } from "@/components/library/collection-header";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { formatTotal, plural } from "@/lib/format";

const decodeAlbumId = Schema.decodeUnknownSync(AlbumId);

export const Route = createFileRoute("/_app/albums/$albumId")({
  params: {
    parse: (params) => ({ albumId: decodeAlbumId(params.albumId) }),
    stringify: (params) => ({ albumId: params.albumId }),
  },
  component: AlbumPage,
});

function AlbumPage() {
  const { albumId } = Route.useParams();
  const detail = useRead("albums.get", { albumId });

  if (detail === undefined) {
    return (
      <div className="flex flex-col gap-8 px-5 pt-row lg:px-12">
        <div className="flex items-end gap-8">
          <Skeleton className="size-[232px] rounded-md" />
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
    <div className="flex flex-col gap-8 px-5 pt-[max(12px,env(safe-area-inset-top))] lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={
          <Artwork
            url={album.artUrl}
            seed={album.id}
            className="size-[232px] rounded-md shadow-[0_20px_48px_color-mix(in_oklab,var(--color-text)_22%,transparent)] dark:shadow-[0_20px_48px_rgb(0_0_0/50%)]"
          />
        }
        phoneCover={
          <Artwork
            url={album.artUrl}
            seed={album.id}
            className="size-[270px] rounded-lg shadow-[0_18px_40px_rgb(0_0_0/22%)]"
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
      />
      <div className="-mx-5 pl-5 lg:mx-0 lg:pl-0">
        <TrackList tracks={tracks} variant="album" label={`Songs on ${album.title}`} />
      </div>
    </div>
  );
}
