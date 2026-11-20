import { Badge } from "@/components/ui/badge";
import { createFileRoute } from "@tanstack/react-router";
import { HeartIcon } from "lucide-react";
import type { ReactNode } from "react";

import { CollectionHeader } from "@/components/library/collection-header";
import { MoreFailed } from "@/components/library/paged";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { formatCount, formatTotal, plural } from "@/lib/format";
import type { Track } from "@/lib/models";
import { preloadLikedSongs, useLikedSongs } from "@/lib/use-liked-songs";

export const Route = createFileRoute("/_app/liked")({
  loader: async ({ context: { platform } }) => {
    await preloadLikedSongs(platform.music);
  },
  pendingComponent: LikedSkeleton,
  component: LikedPage,
});

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

/** The liked songs screen: its header, whose title and cover need no data, above `children`. */
function LikedFrame({
  eyebrow,
  tracks,
  children,
}: {
  readonly eyebrow: string;
  readonly tracks: ReadonlyArray<Track>;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-8 px-5 pt-safe-top-sm lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={<LikedCover size="size-58" />}
        phoneCover={<LikedCover size="size-67.5 rounded-lg" />}
        eyebrow={eyebrow}
        title="Liked songs"
        subtitle={<span className="text-text-muted">Private to you. Newest first.</span>}
        phoneSubtitle="Private to you"
        badge={<Badge tone="outline">Private</Badge>}
        tracks={tracks}
      />
      {children}
    </div>
  );
}

function LikedSkeleton() {
  return (
    <LikedFrame eyebrow="Liked songs" tracks={[]}>
      <TrackListSkeleton />
    </LikedFrame>
  );
}

function LikedPage() {
  const liked = useLikedSongs();

  if (liked === undefined) return <LikedSkeleton />;

  const { tracks, failed } = liked;
  const total = tracks.reduce((sum, track) => sum + track.durationMs, 0);
  const count = liked.done ? plural(tracks.length, "song") : `${formatCount(tracks.length)}+ songs`;

  return (
    <LikedFrame
      eyebrow={`${count}${tracks.length > 0 ? ` · ${formatTotal(total)}` : ""}`}
      tracks={tracks}
    >
      {tracks.length === 0 && failed === null ? (
        <p className="max-w-dialog font-sans text-md/md text-text-muted">
          Songs you like show up here. Tap the heart on any song, or press L while it plays.
        </p>
      ) : (
        <TrackList tracks={tracks} variant="list" label="Liked songs" />
      )}
      {failed === null ? null : <MoreFailed message={failed.message} retry={failed.retry} />}
    </LikedFrame>
  );
}
