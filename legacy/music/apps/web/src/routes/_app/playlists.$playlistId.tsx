import { PlaylistId } from "@music/commands/ids";
import type { Playlist } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import { DropdownMenuItem } from "@music/ui/components/dropdown-menu";
import { FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { Artwork } from "@/components/library/artwork";
import { CollectionHeader } from "@/components/library/collection-header";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { useAddToPlaylist } from "@/components/playlists/track-menu";
import { toastFailure, useAction } from "@/lib/action";
import { formatAgo, formatDuration, formatTotal, plural } from "@/lib/format";

const decodePlaylistId = Schema.decodeUnknownSync(PlaylistId);

export const Route = createFileRoute("/_app/playlists/$playlistId")({
  params: {
    parse: (params) => ({ playlistId: decodePlaylistId(params.playlistId) }),
    stringify: (params) => ({ playlistId: params.playlistId }),
  },
  component: PlaylistPage,
});

/** A 2×2 mosaic of the first covers, one cover, or the empty surface tile. */
function PlaylistCover({
  playlist,
  className,
}: {
  readonly playlist: Playlist;
  readonly className: string;
}) {
  if (playlist.trackCount === 0)
    return <div aria-hidden className={cn("shrink-0 rounded-md bg-surface", className)} />;

  if (playlist.artUrls.length >= 4) {
    return (
      <div
        aria-hidden
        className={cn("grid shrink-0 grid-cols-2 overflow-hidden rounded-md", className)}
      >
        {playlist.artUrls.slice(0, 4).map((url) => (
          <img key={url} src={url} alt="" className="size-full object-cover" />
        ))}
      </div>
    );
  }

  return (
    <Artwork
      url={playlist.artUrls[0] ?? null}
      seed={playlist.id}
      className={cn("rounded-md", className)}
    />
  );
}

function PlaylistPage() {
  const { playlistId } = Route.useParams();
  const detail = useRead("playlists.get", { playlistId });
  const me = useRead("account.me", {});
  const remove = useRun("playlists.remove");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const { playlist, items } = detail;
  const tracks = items.map((item) => item.track);
  const playable = items.flatMap((item) => (item.available ? [item.track] : []));
  const owner = me?.name ?? me?.email ?? "You";

  const eyebrow = [
    "Playlist",
    plural(playlist.trackCount, "song"),
    playlist.trackCount > 0 ? formatTotal(playlist.durationMs) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div className="flex flex-col gap-8 px-5 pt-[max(12px,env(safe-area-inset-top))] lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={
          <PlaylistCover
            playlist={playlist}
            className="size-[232px] shadow-[0_20px_48px_color-mix(in_oklab,var(--color-text)_18%,transparent)]"
          />
        }
        phoneCover={<PlaylistCover playlist={playlist} className="size-[270px] rounded-lg" />}
        eyebrow={eyebrow}
        title={playlist.name}
        subtitle={
          <span className="text-text-muted">
            {playlist.description ?? `${owner} · updated ${formatAgo(playlist.updatedAt)}`}
          </span>
        }
        phoneSubtitle={owner}
        phoneMeta={`${plural(playlist.trackCount, "song")} · updated ${formatAgo(playlist.updatedAt)}`}
        tracks={playable}
        menuExtra={
          <>
            <DropdownMenuItem onClick={() => setRenaming(true)}>Rename…</DropdownMenuItem>
            <DropdownMenuItem tone="danger" onClick={() => setDeleting(true)}>
              Delete playlist…
            </DropdownMenuItem>
          </>
        }
      />
      {items.length === 0 ? (
        <EmptyPlaylist playlist={playlist} />
      ) : (
        <TrackList
          tracks={tracks}
          variant="list"
          unavailable={(index) => items[index]?.available === false}
          label={`Songs in ${playlist.name}`}
          menuExtra={(track, index) => {
            const item = items[index];

            return item === undefined ? null : (
              <DropdownMenuItem
                onClick={() =>
                  void remove({ playlistId: playlist.id, itemId: item.itemId })
                    .then(() => toast.success(`Removed ${track.title} from ${playlist.name}`))
                    .catch(toastFailure)
                }
              >
                Remove from this playlist
              </DropdownMenuItem>
            );
          }}
        />
      )}
      <RenameDialog playlist={playlist} open={renaming} onOpenChange={setRenaming} />
      <DeleteDialog playlist={playlist} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}

function EmptyPlaylist({ playlist }: { readonly playlist: Playlist }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());

  return (
    <section className="flex flex-col gap-4 border-t border-border pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="font-sans text-lg/lg font-semibold tracking-tight text-text">
          Let's find something for this playlist
        </h2>
        <p className="font-sans text-base/sm text-text-muted">
          Use “Add to playlist” from any song's menu, or search below.
        </p>
      </div>
      <Input
        type="search"
        aria-label="Search your library to add songs"
        placeholder="Search your library to add songs"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        fieldClassName="max-w-[480px]"
        start={<SearchIcon aria-hidden />}
      />
      {deferred.length > 0 ? <AddResults playlist={playlist} query={deferred} /> : null}
      <div className="flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3.5 py-2.5">
        <span className="font-mono text-xs/xs tracking-mono text-text-muted">OR ASK AN AGENT</span>
        <code className="font-mono text-sm/xs text-text">music playlists add --help</code>
      </div>
    </section>
  );
}

function AddResults({ playlist, query }: { readonly playlist: Playlist; readonly query: string }) {
  const results = useRead("search", { query, limit: 8 });
  const addToPlaylist = useAddToPlaylist();

  if (results === undefined) return <TrackListSkeleton rows={3} />;

  if (results.tracks.length === 0) {
    return <p className="font-sans text-base/sm text-text-muted">No songs match “{query}”.</p>;
  }

  return (
    <div className="flex max-w-[640px] flex-col">
      {results.tracks.map((track) => (
        <div
          key={track.id}
          className="flex h-[52px] items-center gap-3 rounded-sm px-2 hover:bg-surface"
        >
          <Artwork url={track.artUrl} seed={track.albumId} className="size-row rounded-[4px]" />
          <span className="flex min-w-0 grow flex-col gap-px">
            <span className="truncate font-sans text-base/sm text-text">{track.title}</span>
            <span className="truncate font-sans text-sm/xs text-text-muted">
              {track.artist} · {track.album}
            </span>
          </span>
          <span className="font-mono text-sm/xs text-text-muted">
            {formatDuration(track.durationMs)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="pl-3"
            onClick={() => addToPlaylist(playlist, [track.id])}
          >
            <PlusIcon />
            Add
          </Button>
        </div>
      ))}
    </div>
  );
}

function RenameDialog({
  playlist,
  open,
  onOpenChange,
}: {
  readonly playlist: Playlist;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const rename = useRun("playlists.rename");
  const [name, setName] = useState(playlist.name);

  const [submit, pending] = useAction(
    async () => {
      await rename({ playlistId: playlist.id, name: name.trim() });
      onOpenChange(false);
    },
    { success: () => "Renamed the playlist" },
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Rename playlist">
        <form className="flex flex-col gap-6" onSubmit={onSubmit}>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="rename-playlist">Name</FieldLabel>
            <Input
              id="rename-playlist"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button
              type="submit"
              variant="solid"
              disabled={name.trim().length === 0}
              pending={pending}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  playlist,
  open,
  onOpenChange,
}: {
  readonly playlist: Playlist;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const remove = useRun("playlists.delete");
  const navigate = useNavigate();

  const [submit, pending] = useAction(
    async () => {
      onOpenChange(false);
      // Leave first: this page's live query fails with "not found" once the playlist is gone.
      await navigate({ to: "/playlists" });
      await remove({ playlistId: playlist.id });
    },
    { success: () => `Deleted ${playlist.name}` },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Delete ${playlist.name}?`}
        description="The playlist is removed. Your songs stay in the library."
      >
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button variant="danger" pending={pending} onClick={() => void submit()}>
            Delete playlist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
