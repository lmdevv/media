import { useRead } from "@music/sdk/react";
import { Badge } from "@music/ui/components/badge";
import { createFileRoute } from "@tanstack/react-router";
import { HeartIcon } from "lucide-react";

import { CollectionHeader } from "@/components/library/collection-header";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { formatTotal, plural } from "@/lib/format";

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
  const tracks = useRead("likes.list", {});
  const total = (tracks ?? []).reduce((sum, track) => sum + track.durationMs, 0);

  return (
    <div className="flex flex-col gap-8 px-5 pt-[max(12px,env(safe-area-inset-top))] lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={<LikedCover size="size-[232px]" />}
        phoneCover={<LikedCover size="size-[270px] rounded-lg" />}
        eyebrow={
          tracks === undefined
            ? "Liked songs"
            : `${plural(tracks.length, "song")}${tracks.length > 0 ? ` · ${formatTotal(total)}` : ""}`
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
