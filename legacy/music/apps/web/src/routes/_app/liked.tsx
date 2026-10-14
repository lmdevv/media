import { Badge } from "@music/ui/components/badge";
import { createFileRoute } from "@tanstack/react-router";
import { HeartIcon } from "lucide-react";

import { CollectionHeader } from "@/components/library/collection-header";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { formatCount, formatTotal, plural } from "@/lib/format";
import { useLikedSongs } from "@/lib/use-liked-songs";

export const Route = createFileRoute("/_app/liked")({ component: LikedPage });

function LikedCover({ size }: { readonly size: string }) {
  return (
    <div
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-md bg-text ${size}`}
    >
      <HeartIcon className="size-[34%] text-accent" fill="currentColor" strokeWidth={0} />
    </div>
  );
}

function LikedPage() {
  const liked = useLikedSongs();
  const tracks = liked?.tracks;
  const total = (tracks ?? []).reduce((sum, track) => sum + track.durationMs, 0);

  // Past the songs kept live, the count says there are more.
  const count =
    liked === undefined || liked.done
      ? plural(tracks?.length ?? 0, "song")
      : `${formatCount(liked.tracks.length)}+ songs`;

  return (
    <div className="flex flex-col gap-8 px-5 pt-safe-top-sm lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={<LikedCover size="size-58" />}
        phoneCover={<LikedCover size="size-67.5 rounded-lg" />}
        eyebrow={
          tracks === undefined
            ? "Liked songs"
            : `${count}${tracks.length > 0 ? ` · ${formatTotal(total)}` : ""}`
        }
        title="Liked songs"
        subtitle={<span className="text-text-muted">Private to you. Newest first.</span>}
        phoneSubtitle="Private to you"
        badge={<Badge tone="outline">Private</Badge>}
        tracks={tracks ?? []}
      />
      {tracks === undefined ? (
        <TrackListSkeleton />
      ) : tracks.length === 0 ? (
        <p className="max-w-dialog font-sans text-md/md text-text-muted">
          Songs you like show up here. Tap the heart on any song, or press L while it plays.
        </p>
      ) : (
        <TrackList tracks={tracks} variant="list" label="Liked songs" />
      )}
    </div>
  );
}
