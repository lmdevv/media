import { PlaylistId, UserId } from "@music/commands/ids";
import type { PlaylistItemId } from "@music/commands/ids";
import type { Playlist, PlaylistEntry, Track, UnavailableReason } from "@music/commands/models";
import { can, canEditPlaylistItems, canManagePlaylist } from "@music/commands/permissions";
import { useRead, useRun } from "@music/sdk/react";
import { Badge } from "@music/ui/components/badge";
import { Button } from "@music/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import { DropdownMenuItem } from "@music/ui/components/dropdown-menu";
import { FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Schema } from "effect";
import { PlusIcon, SearchIcon, UsersIcon } from "lucide-react";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { DetailError } from "@/components/route-error";
import type { MissingCopy } from "@/components/route-error";
import { Artwork } from "@/components/library/artwork";
import { CollectionHeader } from "@/components/library/collection-header";
import { useReorder } from "@/components/library/reorder";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { ShareDialog } from "@/components/playlists/share-dialog";
import { useAddToPlaylist } from "@/components/playlists/track-menu";
import { toastFailure, useAction } from "@/lib/action";
import { entryTrack, playableTracks } from "@/lib/playlist-entries";
import { formatAgo, formatDuration, formatTotal, plural } from "@/lib/format";

const decodePlaylistId = Schema.decodeUnknownSync(PlaylistId);

const MISSING: MissingCopy = {
  title: "You can't open this playlist",
  description:
    "It was deleted, it isn't shared with you, or the link is wrong. Ask the person who sent it to share it with you.",
  back: { to: "/playlists", label: "Back to playlists" },
};

export const Route = createFileRoute("/_app/playlists/$playlistId")({
  params: {
    parse: (params) => ({ playlistId: decodePlaylistId(params.playlistId) }),
    stringify: (params) => ({ playlistId: params.playlistId }),
  },
  component: PlaylistPage,
  errorComponent: PlaylistError,
});

const REASONS: Readonly<Record<UnavailableReason, string>> = {
  missing: "Unavailable",
  no_access: "No access",
};

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

/** How a playlist is shared, for the header badge; null when it is private. */
const sharingLabel = (playlist: Playlist): string | null => {
  if (playlist.access === "collaborator") return "Collaborative";

  if (playlist.visibility === "shared") return "Shared by link";

  return playlist.sharedWithPeople ? "Shared" : null;
};

/**
 * "Added by" under each song, once someone besides the owner added any: a playlist only you
 * edit doesn't need it.
 */
const useBylines = (
  playlist: Playlist,
  items: ReadonlyArray<PlaylistEntry>,
): ((index: number) => string | null) | undefined => {
  const ownerId = playlist.owner?.id;

  // The same function while the songs are, so the rows stay memoized.
  return useMemo(() => {
    const mixed = items.some((item) => item.addedBy !== null && item.addedBy.id !== ownerId);

    return mixed
      ? (index: number) => {
          const addedBy = items[index]?.addedBy;

          return addedBy === null || addedBy === undefined ? null : `Added by ${addedBy.name}`;
        }
      : undefined;
  }, [items, ownerId]);
};

function PlaylistPage() {
  const { playlistId } = Route.useParams();
  const detail = useRead("playlists.get", { playlistId });

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

  return <PlaylistView playlist={detail.playlist} items={detail.items} />;
}

function PlaylistView({
  playlist,
  items,
}: {
  readonly playlist: Playlist;
  readonly items: ReadonlyArray<PlaylistEntry>;
}) {
  const [dialog, setDialog] = useState<PlaylistDialog | null>(null);
  const canShare = useCanShare(playlist);
  const playable = playableTracks(items);
  const owner = playlist.owner?.name ?? "Someone who left";
  const badge = sharingLabel(playlist);

  const eyebrow = [
    "Playlist",
    plural(playlist.trackCount, "song"),
    playlist.trackCount > 0 ? formatTotal(playlist.durationMs) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div className="flex flex-col gap-8 px-5 pt-safe-top-sm lg:px-12 lg:pt-row">
      <CollectionHeader
        cover={<PlaylistCover playlist={playlist} className="size-58 shadow-cover" />}
        phoneCover={<PlaylistCover playlist={playlist} className="size-67.5 rounded-lg" />}
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
        link={{ kind: "playlist", id: playlist.id }}
        badge={badge === null ? null : <Badge tone="surface">{badge}</Badge>}
        actions={
          canShare ? (
            <Button variant="secondary" className="pl-4" onClick={() => setDialog("share")}>
              <UsersIcon />
              Share
            </Button>
          ) : null
        }
        menuExtra={<PlaylistMenuItems playlist={playlist} open={setDialog} />}
      />
      <PlaylistSongs playlist={playlist} items={items} />
      <PlaylistDialogs playlist={playlist} dialog={dialog} setDialog={setDialog} />
    </div>
  );
}

/** Whether the viewer may share this playlist: its owner, unless they are a guest. */
const useCanShare = (playlist: Playlist): boolean => {
  const me = useRead("account.me", {});

  return canManagePlaylist(playlist.access) && me !== undefined && can(me.role, "share");
};

/** The dialogs a playlist's menu opens. */
type PlaylistDialog = "edit" | "share" | "delete" | "leave";

/**
 * The playlist's own items in its "…" menu: the owner edits, shares, or deletes it; someone it was
 * shared with by name can leave it. One opened only by link has nothing to leave.
 */
function PlaylistMenuItems({
  playlist,
  open,
}: {
  readonly playlist: Playlist;
  readonly open: (dialog: PlaylistDialog) => void;
}) {
  const canManage = canManagePlaylist(playlist.access);
  const canShare = useCanShare(playlist);
  const sharedWithMe = useRead("playlists.shared", canManage ? "skip" : {});

  if (canManage) {
    return (
      <>
        <DropdownMenuItem onClick={() => open("edit")}>Edit details…</DropdownMenuItem>
        {canShare ? (
          <DropdownMenuItem onClick={() => open("share")}>Share…</DropdownMenuItem>
        ) : null}
        <DropdownMenuItem tone="danger" onClick={() => open("delete")}>
          Delete playlist…
        </DropdownMenuItem>
      </>
    );
  }

  return sharedWithMe?.some((entry) => entry.id === playlist.id) === true ? (
    <DropdownMenuItem tone="danger" onClick={() => open("leave")}>
      Leave playlist…
    </DropdownMenuItem>
  ) : null;
}

function PlaylistDialogs({
  playlist,
  dialog,
  setDialog,
}: {
  readonly playlist: Playlist;
  readonly dialog: PlaylistDialog | null;
  readonly setDialog: (dialog: PlaylistDialog | null) => void;
}) {
  const me = useRead("account.me", {});

  const props = (name: PlaylistDialog) => ({
    playlist,
    open: dialog === name,
    onOpenChange: (open: boolean) => setDialog(open ? name : null),
  });

  if (!canManagePlaylist(playlist.access)) {
    return me === undefined ? null : <LeaveDialog {...props("leave")} me={UserId.make(me.id)} />;
  }

  return (
    <>
      <EditDialog {...props("edit")} />
      {can(me?.role ?? "guest", "share") ? <ShareDialog {...props("share")} /> : null}
      <DeleteDialog {...props("delete")} />
    </>
  );
}

/**
 * The playlist's songs. Owners and collaborators can remove and reorder them: drag on desktop,
 * arrow keys on a row's handle, or Reorder mode with up/down buttons on phones.
 */
function PlaylistSongs({
  playlist,
  items,
}: {
  readonly playlist: Playlist;
  readonly items: ReadonlyArray<PlaylistEntry>;
}) {
  const remove = useRun("playlists.remove");
  const move = useRun("playlists.move");
  const [reordering, setReordering] = useState(false);
  const canEdit = canEditPlaylistItems(playlist.access);
  const byline = useBylines(playlist, items);

  const reorder = useReorder<PlaylistItemId>(
    items.map((item) => item.itemId),
    null,
    async (itemId, afterItemId) => {
      try {
        await move(
          afterItemId === null
            ? { playlistId: playlist.id, itemId }
            : { playlistId: playlist.id, itemId, afterItemId },
        );
      } catch (cause) {
        toastFailure(cause);
        throw cause;
      }
    },
  );

  // The same values while the playlist is, so its rows skip re-rendering when nothing changed.
  const tracks = useMemo(() => items.map(entryTrack), [items]);

  const withheld = useCallback((index: number) => items[index]?.track === null, [items]);

  // Rows keyed by entry, so a move doesn't remount the rows between its old and new places.
  const rowKey = useCallback(
    (index: number) => items[index]?.itemId ?? `missing-${String(index)}`,
    [items],
  );

  const unavailable = useCallback(
    (index: number) => {
      const reason = items[index]?.reason ?? null;

      return reason === null ? null : REASONS[reason];
    },
    [items],
  );

  const menuExtra = useCallback(
    (track: Track, index: number) => {
      const item = items[index];

      return item === undefined || !canEdit ? null : (
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
    },
    [items, canEdit, remove, playlist.id, playlist.name],
  );

  if (items.length === 0) {
    return canEdit ? (
      <EmptyPlaylist playlist={playlist} />
    ) : (
      <p className="font-sans text-md/md text-text-muted">No songs in this playlist yet.</p>
    );
  }

  return (
    <>
      {canEdit && items.length > 1 ? (
        <div className="-mb-4 flex justify-end lg:hidden">
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={reordering}
            onClick={() => setReordering((on) => !on)}
          >
            {reordering ? "Done" : "Reorder"}
          </Button>
        </div>
      ) : null}
      <TrackList
        tracks={tracks}
        withheld={withheld}
        variant="list"
        unavailable={unavailable}
        byline={byline}
        reorder={canEdit ? { reorder, mode: reordering ? "buttons" : "drag" } : undefined}
        label={`Songs in ${playlist.name}`}
        menuExtra={menuExtra}
        rowKey={rowKey}
      />
    </>
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
        fieldClassName="max-w-120"
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
    <div className="flex max-w-160 flex-col">
      {results.tracks.map((track) => (
        <div
          key={track.id}
          className="flex h-13 items-center gap-3 rounded-sm px-2 hover:bg-surface"
        >
          <Artwork url={track.artUrl} seed={track.albumId} className="size-row rounded-xs" />
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

/** Name and description, which only the owner changes. */
function EditDialog({
  playlist,
  open,
  onOpenChange,
}: {
  readonly playlist: Playlist;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <EditForm playlist={playlist} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function EditForm({
  playlist,
  onDone,
}: {
  readonly playlist: Playlist;
  readonly onDone: () => void;
}) {
  const update = useRun("playlists.update");
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description ?? "");

  const [submit, pending] = useAction(
    async () => {
      await update({
        playlistId: playlist.id,
        name: name.trim(),
        description: description.trim(),
      });
      onDone();
    },
    { success: () => "Saved the playlist" },
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <DialogContent title="Edit details">
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="playlist-name">Name</FieldLabel>
          <Input
            id="playlist-name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="playlist-description">Description</FieldLabel>
          <Input
            id="playlist-description"
            maxLength={500}
            placeholder="Add an optional description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
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
        description={
          playlist.sharedWithPeople || playlist.visibility === "shared"
            ? "The playlist is removed for everyone it's shared with. Your songs stay in the library."
            : "The playlist is removed. Your songs stay in the library."
        }
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

function PlaylistError(props: ErrorComponentProps) {
  return <DetailError {...props} copy={MISSING} />;
}

/** Leaving a playlist someone shared with you; they can share it again. */
function LeaveDialog({
  playlist,
  me,
  open,
  onOpenChange,
}: {
  readonly playlist: Playlist;
  readonly me: UserId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const unshare = useRun("playlists.unshare");
  const navigate = useNavigate();

  const [submit, pending] = useAction(
    async () => {
      onOpenChange(false);
      await navigate({ to: "/playlists" });
      await unshare({ playlistId: playlist.id, userId: me });
    },
    { success: () => `Left ${playlist.name}` },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Leave ${playlist.name}?`}
        description={`It leaves your Shared with you list. ${playlist.owner?.name ?? "The owner"} can share it with you again.`}
      >
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button variant="danger" pending={pending} onClick={() => void submit()}>
            Leave playlist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
